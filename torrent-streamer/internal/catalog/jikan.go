package catalog

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// Jikan catalog provider (public MyAnimeList API; no credentials).
type Jikan struct {
	base string
	http *http.Client
}

type JikanOptions struct {
	BaseURL string // default https://api.jikan.moe
	HTTP    *http.Client
}

func NewJikan(options JikanOptions) *Jikan {
	base := options.BaseURL
	if base == "" {
		base = "https://api.jikan.moe"
	}
	return &Jikan{base: strings.TrimRight(base, "/"), http: options.HTTP}
}

func (p *Jikan) Name() string { return "jikan" }

type jikanListResponse struct {
	Data []jikanAnime `json:"data"`
}

type jikanAnime struct {
	MalID         int64   `json:"mal_id"`
	URL           string  `json:"url"`
	Title         string  `json:"title"`
	TitleEnglish  string  `json:"title_english"`
	TitleJapanese string  `json:"title_japanese"`
	Synopsis      string  `json:"synopsis"`
	Episodes      int     `json:"episodes"`
	Duration      string  `json:"duration"`
	Score         float64 `json:"score"`
	Aired         struct {
		From string `json:"from"`
	} `json:"aired"`
	Images struct {
		JPG struct {
			ImageURL      string `json:"image_url"`
			LargeImageURL string `json:"large_image_url"`
		} `json:"jpg"`
	} `json:"images"`
	Genres []struct {
		Name string `json:"name"`
	} `json:"genres"`
}

func (p *Jikan) Search(ctx context.Context, query SearchQuery) ([]Title, error) {
	limit := query.Limit
	if limit <= 0 {
		limit = 24
	}
	endpoint := p.base + "/v4/anime?q=" + url.QueryEscape(query.Query) + "&limit=" + strconv.Itoa(limit) + "&sfw=true"
	var payload jikanListResponse
	if err := fetchJSON(ctx, p.http, endpoint, &payload); err != nil {
		return nil, err
	}
	titles := make([]Title, 0, len(payload.Data))
	for _, anime := range payload.Data {
		titles = append(titles, p.toTitle(anime))
	}
	return titles, nil
}

func (p *Jikan) Detail(ctx context.Context, request DetailRequest) (Title, error) {
	externalID := request.ProviderIDs["jikan"]
	if externalID == "" {
		return Title{}, ErrNotFound
	}
	var payload struct {
		Data jikanAnime `json:"data"`
	}
	if err := fetchJSON(ctx, p.http, p.base+"/v4/anime/"+externalID, &payload); err != nil {
		return Title{}, err
	}
	return p.toTitle(payload.Data), nil
}

func (p *Jikan) toTitle(anime jikanAnime) Title {
	title := anime.TitleEnglish
	if title == "" {
		title = anime.Title
	}
	if title == "" {
		title = anime.TitleJapanese
	}
	artwork := map[string]string{}
	if anime.Images.JPG.LargeImageURL != "" {
		artwork["poster"] = anime.Images.JPG.LargeImageURL
	} else if anime.Images.JPG.ImageURL != "" {
		artwork["poster"] = anime.Images.JPG.ImageURL
	}
	externalID := strconv.FormatInt(anime.MalID, 10)
	genres := make([]string, 0, len(anime.Genres))
	for _, genre := range anime.Genres {
		genres = append(genres, genre.Name)
	}
	return Title{
		ID:            "jikan:" + externalID,
		Type:          TypeAnime,
		Title:         title,
		OriginalTitle: anime.TitleJapanese,
		Year:          yearFromDate(anime.Aired.From),
		Overview:      anime.Synopsis,
		Artwork:       artwork,
		ProviderIDs:   map[string]string{"jikan": externalID},
		MergedFrom:    []string{"jikan"},
		Runtime:       parseJikanDurationMinutes(anime.Duration),
		Genres:        genres,
		ExternalLinks: map[string]string{},
	}
}

func parseJikanDurationMinutes(duration string) int {
	// e.g. "24 min per ep", "2 hr per ep" — minutes are authoritative when present.
	fields := strings.Fields(duration)
	for i, part := range fields {
		value, err := strconv.Atoi(part)
		if err != nil {
			continue
		}
		if i+1 < len(fields) && strings.HasPrefix(fields[i+1], "min") {
			return value
		}
		if i+1 < len(fields) && strings.HasPrefix(fields[i+1], "hr") {
			return value * 60
		}
	}
	return 0
}

type jikanEpisodesResponse struct {
	Data []struct {
		MalID    int64  `json:"mal_id"`
		Title    string `json:"title"`
		Japanese string `json:"title_japanese"`
		Aired    string `json:"aired"`
	} `json:"data"`
}

func (p *Jikan) Episodes(ctx context.Context, request EpisodeRequest) ([]Episode, error) {
	externalID := request.ProviderIDs["jikan"]
	if externalID == "" {
		return nil, ErrNotFound
	}
	var payload jikanEpisodesResponse
	if err := fetchJSON(ctx, p.http, p.base+"/v4/anime/"+externalID+"/episodes", &payload); err != nil {
		return nil, err
	}
	episodes := make([]Episode, 0, len(payload.Data))
	for i, episode := range payload.Data {
		number := i + 1
		episodes = append(episodes, Episode{
			ID:          "jikan:" + externalID + ":1:" + strconv.Itoa(number),
			Season:      1,
			Episode:     number,
			Title:       episode.Title,
			AirDate:     episode.Aired,
			ProviderIDs: map[string]string{"jikan": externalID},
		})
	}
	return episodes, nil
}
