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

type aniZipMappings struct {
	Title   string `json:"title"`
	English struct {
		Title string `json:"title"`
	} `json:"english"`
	IMDBID   string `json:"imdbId"`
	Episodes map[string]struct {
		Season   int    `json:"season"`
		Episode  int    `json:"episode"`
		Absolute int    `json:"absoluteNumber"`
		AirDate  string `json:"airDate"`
		Title    string `json:"title"`
		Image    string `json:"image"`
		Overview string `json:"overview"`
		Duration int    `json:"duration"`
	} `json:"episodes"`
}

func (p *AniZip) lookupID(request map[string]string) (queryParam, value string, err error) {
	for _, candidate := range []struct{ namespace, param string }{
		{"anilist", "anilistId"},
		{"jikan", "malId"},
		{"kitsu", "kitsuId"},
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

func (p *AniZip) Detail(ctx context.Context, request DetailRequest) (Title, error) {
	payload, value, err := p.fetchMappings(ctx, request.ProviderIDs)
	if err != nil {
		return Title{}, err
	}
	title := payload.English.Title
	if title == "" {
		title = payload.Title
	}
	providerIDs := map[string]string{"anizip": value}
	if payload.IMDBID != "" {
		providerIDs["imdb"] = payload.IMDBID
	}
	return Title{
		ID:          "anizip:" + value,
		Type:        TypeAnime,
		Title:       title,
		IMDBID:      payload.IMDBID,
		ProviderIDs: providerIDs,
		MergedFrom:  []string{"anizip"},
	}, nil
}

func (p *AniZip) Episodes(ctx context.Context, request EpisodeRequest) ([]Episode, error) {
	payload, value, err := p.fetchMappings(ctx, request.ProviderIDs)
	if err != nil {
		return nil, err
	}
	episodes := make([]Episode, 0, len(payload.Episodes))
	for key, episode := range payload.Episodes {
		number := episode.Episode
		if number == 0 {
			number, err = strconv.Atoi(key)
			if err != nil {
				continue
			}
		}
		season := episode.Season
		if season == 0 {
			season = request.Season
		}
		episodes = append(episodes, Episode{
			ID:          "anizip:" + value + ":" + strconv.Itoa(season) + ":" + strconv.Itoa(number),
			Season:      season,
			Episode:     number,
			Title:       episode.Title,
			AirDate:     episode.AirDate,
			Still:       episode.Image,
			Overview:    episode.Overview,
			DurationS:   episode.Duration * 60,
			ProviderIDs: map[string]string{"anizip": value},
		})
	}
	return episodes, nil
}
