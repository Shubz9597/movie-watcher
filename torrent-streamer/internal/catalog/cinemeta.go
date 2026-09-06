package catalog

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// Cinemeta catalog provider (Stremio official metadata addon; IMDb-keyed).
type Cinemeta struct {
	base string
	http *http.Client
}

type CinemetaOptions struct {
	BaseURL string // default https://v3-cinemeta.strem.io
	HTTP    *http.Client
}

func NewCinemeta(options CinemetaOptions) *Cinemeta {
	base := options.BaseURL
	if base == "" {
		base = "https://v3-cinemeta.strem.io"
	}
	return &Cinemeta{base: strings.TrimRight(base, "/"), http: options.HTTP}
}

func (p *Cinemeta) Name() string { return "cinemeta" }

type cinemetaMetaResponse struct {
	Meta struct {
		ID          string        `json:"id"`
		IMDBID      string        `json:"imdb_id"`
		Name        string        `json:"name"`
		Type        string        `json:"type"`
		ReleaseInfo string        `json:"releaseInfo"`
		Poster      jsonRawString `json:"poster"`
		Background  jsonRawString `json:"background"`
		Description string        `json:"description"`
		Runtime     string        `json:"runtime"`
		Genre       []string      `json:"genre"`
		Videos      []struct {
			ID        string        `json:"id"`
			Season    jsonRawNumber `json:"season"`
			Episode   jsonRawNumber `json:"episode"`
			Name      string        `json:"name"`
			Released  string        `json:"released"`
			Thumbnail jsonRawString `json:"thumbnail"`
			Overview  string        `json:"overview"`
		} `json:"videos"`
	} `json:"meta"`
}

// jsonRawString tolerates Cinemeta fields that may be strings or objects.
type jsonRawString string

func (r *jsonRawString) UnmarshalJSON(data []byte) error {
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "null" {
		*r = ""
		return nil
	}
	if len(trimmed) >= 2 && trimmed[0] == '"' {
		var value string
		if err := json.Unmarshal(data, &value); err != nil {
			return err
		}
		*r = jsonRawString(value)
		return nil
	}
	var object struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal(data, &object); err == nil && object.URL != "" {
		*r = jsonRawString(object.URL)
		return nil
	}
	*r = ""
	return nil
}

// jsonRawNumber tolerates absent or fractional season/episode markers.
type jsonRawNumber int

func (r *jsonRawNumber) UnmarshalJSON(data []byte) error {
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "null" || trimmed == `""` {
		*r = 0
		return nil
	}
	value, err := strconv.Atoi(trimmed)
	if err != nil {
		*r = 0
		return nil
	}
	*r = jsonRawNumber(value)
	return nil
}

// Detail resolves an imdb:<id> title, trying series then movie
// (deterministic; Cinemeta requires the type in the path).
func (p *Cinemeta) Detail(ctx context.Context, request DetailRequest) (Title, error) {
	externalID := request.ProviderIDs["imdb"]
	if externalID == "" {
		return Title{}, ErrNotFound
	}
	meta, err := p.fetchMeta(ctx, externalID, "series")
	if err != nil && err != ErrNotFound {
		return Title{}, err
	}
	if err == ErrNotFound {
		meta, err = p.fetchMeta(ctx, externalID, "movie")
		if err != nil {
			return Title{}, err
		}
	}
	return p.toTitle(externalID, meta), nil
}

func (p *Cinemeta) fetchMeta(ctx context.Context, externalID, kind string) (cinemetaMetaResponse, error) {
	var payload cinemetaMetaResponse
	if err := fetchJSON(ctx, p.http, p.base+"/meta/"+kind+"/"+url.QueryEscape(externalID)+".json", &payload); err != nil {
		return cinemetaMetaResponse{}, err
	}
	if payload.Meta.ID == "" && payload.Meta.IMDBID == "" {
		return cinemetaMetaResponse{}, ErrNotFound
	}
	return payload, nil
}

func (p *Cinemeta) toTitle(externalID string, meta cinemetaMetaResponse) Title {
	artwork := map[string]string{}
	if meta.Meta.Poster != "" {
		artwork["poster"] = string(meta.Meta.Poster)
	}
	if meta.Meta.Background != "" {
		artwork["background"] = string(meta.Meta.Background)
	}
	kind := TypeSeries
	if meta.Meta.Type == "movie" {
		kind = TypeMovie
	}
	return Title{
		ID:            "imdb:" + externalID,
		Type:          kind,
		Title:         meta.Meta.Name,
		Year:          yearFromReleaseInfo(meta.Meta.ReleaseInfo),
		Overview:      meta.Meta.Description,
		Artwork:       artwork,
		ProviderIDs:   map[string]string{"imdb": externalID},
		IMDBID:        externalID,
		MergedFrom:    []string{"cinemeta"},
		Runtime:       parseRuntimeMinutes(meta.Meta.Runtime),
		Genres:        meta.Meta.Genre,
		ExternalLinks: map[string]string{},
	}
}

func yearFromReleaseInfo(releaseInfo string) int {
	// e.g. "2023", "2023–2026"
	if len(releaseInfo) < 4 {
		return 0
	}
	return yearFromDate(releaseInfo[:4])
}

func parseRuntimeMinutes(runtime string) int {
	// e.g. "110 min", "2h 15min", "42m"
	minutes := 0
	for i := 0; i < len(runtime); i++ {
		start := i
		for i < len(runtime) && runtime[i] >= '0' && runtime[i] <= '9' {
			i++
		}
		if i == start {
			continue
		}
		value, err := strconv.Atoi(runtime[start:i])
		if err != nil {
			continue
		}
		unit := strings.TrimLeft(strings.ToLower(runtime[i:]), " ")
		switch {
		case strings.HasPrefix(unit, "h"):
			minutes += value * 60
		case strings.HasPrefix(unit, "min") || strings.HasPrefix(unit, "m"):
			minutes += value
		}
	}
	return minutes
}

func (p *Cinemeta) Episodes(ctx context.Context, request EpisodeRequest) ([]Episode, error) {
	externalID := request.ProviderIDs["imdb"]
	if externalID == "" {
		return nil, ErrNotFound
	}
	meta, err := p.fetchMeta(ctx, externalID, "series")
	if err != nil {
		return nil, err
	}
	episodes := make([]Episode, 0, len(meta.Meta.Videos))
	for _, video := range meta.Meta.Videos {
		season, episode := int(video.Season), int(video.Episode)
		if season <= 0 || episode <= 0 {
			continue
		}
		if request.Season > 0 && season != request.Season {
			continue
		}
		episodes = append(episodes, Episode{
			ID:          "imdb:" + externalID + ":" + strconv.Itoa(season) + ":" + strconv.Itoa(episode),
			Season:      season,
			Episode:     episode,
			Title:       video.Name,
			AirDate:     video.Released,
			Still:       string(video.Thumbnail),
			Overview:    video.Overview,
			ProviderIDs: map[string]string{"imdb": externalID},
		})
	}
	return episodes, nil
}
