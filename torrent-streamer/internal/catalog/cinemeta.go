package catalog

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
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
		MovieDBID   jsonRawNumber `json:"moviedb_id"`
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
	// The TMDb id Cinemeta lists is NOT a provider id here: as a cross-link
	// it would pull TMDb into titles it never described (an AniList anime
	// would turn into a TMDb series). Search reads it via cinemetaTMDbID.
	providerIDs := map[string]string{"imdb": externalID}
	return Title{
		ID:            "imdb:" + externalID,
		Type:          kind,
		Title:         meta.Meta.Name,
		Year:          yearFromReleaseInfo(meta.Meta.ReleaseInfo),
		Overview:      meta.Meta.Description,
		Artwork:       artwork,
		ProviderIDs:   providerIDs,
		IMDBID:        externalID,
		MergedFrom:    []string{"cinemeta"},
		Seasons:       cinemetaSeasons(meta),
		Runtime:       parseRuntimeMinutes(meta.Meta.Runtime),
		Genres:        meta.Meta.Genre,
		ExternalLinks: map[string]string{},
	}
}

// cinemetaTMDbID is the TMDb id Cinemeta lists for a title ("tv:13916", as
// TMDb's own provider ids), or "".
func cinemetaTMDbID(meta cinemetaMetaResponse) string {
	if meta.Meta.MovieDBID <= 0 {
		return ""
	}
	mediaType := "tv"
	if meta.Meta.Type == "movie" {
		mediaType = "movie"
	}
	return mediaType + ":" + strconv.Itoa(int(meta.Meta.MovieDBID))
}

// cinemetaSeasons summarizes the numbered seasons in the episode list (as
// TMDb's season list: number, name, episode count, first air date), so a
// title answered by Cinemeta alone still has its season picker.
func cinemetaSeasons(meta cinemetaMetaResponse) []Season {
	bySeason := map[int]*Season{}
	for _, video := range meta.Meta.Videos {
		number := int(video.Season)
		if number <= 0 || int(video.Episode) <= 0 {
			continue
		}
		season := bySeason[number]
		if season == nil {
			season = &Season{Number: number, Name: "Season " + strconv.Itoa(number)}
			bySeason[number] = season
		}
		season.EpisodeCount++
		if released := video.Released; len(released) >= 10 && (season.AirDate == "" || released[:10] < season.AirDate) {
			season.AirDate = released[:10]
		}
	}
	seasons := make([]Season, 0, len(bySeason))
	for _, season := range bySeason {
		seasons = append(seasons, *season)
	}
	sort.Slice(seasons, func(i, j int) bool { return seasons[i].Number < seasons[j].Number })
	if len(seasons) == 0 {
		return nil
	}
	return seasons
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

func (p *Cinemeta) SupportsIDs(ids map[string]string) bool { return ids["imdb"] != "" }

// cinemetaSearchPerType bounds the fallback search: each result needs one
// meta lookup for its TMDb id.
const cinemetaSearchPerType = 8

// SearchAsTMDb searches Cinemeta and returns the hits as the TMDb titles the
// app knows (tmdb:tv:13916 ...), using the TMDb id Cinemeta lists for each.
// It stands in for TMDb search while TMDb is unreachable; hits without a
// TMDb id are dropped.
func (p *Cinemeta) SearchAsTMDb(ctx context.Context, query SearchQuery) ([]Title, error) {
	kinds := []string{"movie", "series"}
	switch query.Type {
	case TypeMovie:
		kinds = []string{"movie"}
	case TypeSeries:
		kinds = []string{"series"}
	case TypeAnime:
		return nil, ErrNotFound // anime search is AniList's
	}
	type hit struct{ imdb, kind string }
	var hits []hit
	var firstErr error
	for _, kind := range kinds {
		var payload struct {
			Metas []struct {
				ID     string `json:"id"`
				IMDBID string `json:"imdb_id"`
			} `json:"metas"`
		}
		endpoint := p.base + "/catalog/" + kind + "/top/search=" + url.PathEscape(query.Query) + ".json"
		if err := fetchJSON(ctx, p.http, endpoint, &payload); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		for i, meta := range payload.Metas {
			if i >= cinemetaSearchPerType {
				break
			}
			id := meta.IMDBID
			if id == "" {
				id = meta.ID
			}
			if strings.HasPrefix(id, "tt") {
				hits = append(hits, hit{imdb: id, kind: kind})
			}
		}
	}
	titles := make([]Title, len(hits))
	var wait sync.WaitGroup
	for i, h := range hits {
		wait.Go(func() {
			meta, err := p.fetchMeta(ctx, h.imdb, h.kind)
			if err != nil {
				return
			}
			title := p.toTitle(h.imdb, meta)
			tmdbID := cinemetaTMDbID(meta)
			if tmdbID == "" {
				return
			}
			title.ProviderIDs["tmdb"] = tmdbID
			title.ID = "tmdb:" + tmdbID
			title.Format = strings.SplitN(tmdbID, ":", 2)[0]
			title.Seasons = nil // search results carry no season list (as TMDb's)
			title.Runtime, title.Genres = 0, nil
			titles[i] = title
		})
	}
	wait.Wait()
	found := make([]Title, 0, len(titles))
	for _, title := range titles {
		if title.ID != "" {
			found = append(found, title)
		}
	}
	if len(found) == 0 && firstErr != nil {
		return nil, firstErr
	}
	return found, nil
}
