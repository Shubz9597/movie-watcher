package catalog

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// AniZip catalog provider (public metadata mappings keyed by AniList/MAL/
// Kitsu ids; no credentials). It contributes enriched episode metadata and
// resolves IMDb cross-links for anime titles.
type AniZip struct {
	base string
	http *http.Client
}

type AniZipOptions struct {
	BaseURL string // default https://api.ani.zip
	HTTP    *http.Client
}

func NewAniZip(options AniZipOptions) *AniZip {
	base := options.BaseURL
	if base == "" {
		base = "https://api.ani.zip"
	}
	return &AniZip{base: strings.TrimRight(base, "/"), http: options.HTTP}
}

func (p *AniZip) Name() string { return "anizip" }

// aniZipMappings models the live api.ani.zip /mappings payload: titles and
// episode titles are language maps, regular episodes are keyed "1", "2", …
// (specials use "S1"…), and cross-links live under "mappings".
type aniZipMappings struct {
	Titles   map[string]string        `json:"titles"`
	Episodes map[string]aniZipEpisode `json:"episodes"`
	Mappings struct {
		IMDBID string `json:"imdb_id"`
	} `json:"mappings"`
}

type aniZipEpisode struct {
	Title    map[string]string `json:"title"`
	AirDate  string            `json:"airDate"`
	Image    string            `json:"image"`
	Overview string            `json:"overview"`
	Summary  string            `json:"summary"`
	Runtime  float64           `json:"runtime"`
	Length   float64           `json:"length"`
}

func (p *AniZip) lookupID(request map[string]string) (queryParam, value string, err error) {
	for _, candidate := range []struct{ namespace, param string }{
		{"anilist", "anilist_id"},
		{"jikan", "mal_id"},
		{"kitsu", "kitsu_id"},
	} {
		if id := request[candidate.namespace]; id != "" {
			return candidate.param, id, nil
		}
	}
	return "", "", ErrNotFound
}

func (p *AniZip) fetchMappings(ctx context.Context, request map[string]string) (aniZipMappings, string, error) {
	param, value, err := p.lookupID(request)
	if err != nil {
		return aniZipMappings{}, "", err
	}
	var payload aniZipMappings
	endpoint := p.base + "/mappings?" + param + "=" + url.QueryEscape(value)
	if err := fetchJSON(ctx, p.http, endpoint, &payload); err != nil {
		return aniZipMappings{}, "", err
	}
	return payload, value, nil
}

// preferredTitle picks English, then romaji, then Japanese.
func preferredTitle(titles map[string]string) string {
	for _, language := range []string{"en", "x-jat", "ja"} {
		if title := strings.TrimSpace(titles[language]); title != "" {
			return title
		}
	}
	return ""
}

func (p *AniZip) Detail(ctx context.Context, request DetailRequest) (Title, error) {
	payload, value, err := p.fetchMappings(ctx, request.ProviderIDs)
	if err != nil {
		return Title{}, err
	}
	providerIDs := map[string]string{"anizip": value}
	if payload.Mappings.IMDBID != "" {
		providerIDs["imdb"] = payload.Mappings.IMDBID
	}
	return Title{
		ID:          "anizip:" + value,
		Type:        TypeAnime,
		Title:       preferredTitle(payload.Titles),
		IMDBID:      payload.Mappings.IMDBID,
		ProviderIDs: providerIDs,
		MergedFrom:  []string{"anizip"},
	}, nil
}

// Episodes maps the regular (numeric-key) episodes of one AniList entry.
// AniList numbers episodes per entry, so the key is the episode number and
// the requested season is kept (TVDB season numbers would not line up with
// sequel entries).
func (p *AniZip) Episodes(ctx context.Context, request EpisodeRequest) ([]Episode, error) {
	payload, value, err := p.fetchMappings(ctx, request.ProviderIDs)
	if err != nil {
		return nil, err
	}
	season := request.Season
	if season <= 0 {
		season = 1
	}
	episodes := make([]Episode, 0, len(payload.Episodes))
	for key, episode := range payload.Episodes {
		number, err := strconv.Atoi(key)
		if err != nil || number <= 0 {
			continue // specials ("S1"…) are not part of the numbered list
		}
		overview := episode.Overview
		if overview == "" {
			overview = episode.Summary
		}
		minutes := episode.Runtime
		if minutes <= 0 {
			minutes = episode.Length
		}
		episodes = append(episodes, Episode{
			ID:          "anizip:" + value + ":" + strconv.Itoa(season) + ":" + strconv.Itoa(number),
			Season:      season,
			Episode:     number,
			Title:       preferredTitle(episode.Title),
			AirDate:     episode.AirDate,
			Still:       episode.Image,
			Overview:    overview,
			DurationS:   int(minutes * 60),
			ProviderIDs: map[string]string{"anizip": value},
		})
	}
	return episodes, nil
}
