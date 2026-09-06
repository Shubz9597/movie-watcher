package catalog

import (
	"context"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
)

// TMDb catalog provider (server-side API key, FR-001/FR-003: the key never
// leaves the backend).
type TMDb struct {
	base   string
	apiKey string
	http   *http.Client
}

type TMDbOptions struct {
	BaseURL string // default https://api.themoviedb.org
	APIKey  string
	HTTP    *http.Client
}

func NewTMDb(options TMDbOptions) *TMDb {
	base := options.BaseURL
	if base == "" {
		base = "https://api.themoviedb.org"
	}
	return &TMDb{base: strings.TrimRight(base, "/"), apiKey: options.APIKey, http: options.HTTP}
}

func (p *TMDb) Name() string { return "tmdb" }

func (p *TMDb) endpoint(path string, params map[string]string) string {
	query := url.Values{"api_key": {p.apiKey}}
	for key, value := range params {
		query.Set(key, value)
	}
	return p.base + path + "?" + query.Encode()
}

type tmdbSearchResponse struct {
	TotalPages int `json:"total_pages"`
	Results []struct {
		MediaType        string `json:"media_type"`
		ID               int64  `json:"id"`
		Title            string `json:"title"`
		Name             string `json:"name"`
		OriginalTitle    string `json:"original_title"`
		OriginalName     string `json:"original_name"`
		ReleaseDate      string `json:"release_date"`
		FirstAirDate     string `json:"first_air_date"`
		Overview         string `json:"overview"`
		PosterPath       string `json:"poster_path"`
		BackdropPath     string `json:"backdrop_path"`
		OriginalLanguage string `json:"original_language"`
		GenreIDs         []int  `json:"genre_ids"`
	} `json:"results"`
}

func (p *TMDb) Search(ctx context.Context, query SearchQuery) ([]Title, error) {
	if p.apiKey == "" {
		return nil, errProviderUnavailable
	}
	var payload tmdbSearchResponse
	endpoint := p.endpoint("/3/search/multi", map[string]string{"query": query.Query, "include_adult": "false"})
	if err := fetchJSON(ctx, p.http, endpoint, &payload); err != nil {
		return nil, err
	}
	titles := make([]Title, 0, len(payload.Results))
	for _, result := range payload.Results {
		if result.MediaType != "movie" && result.MediaType != "tv" {
			continue
		}
		titles = append(titles, p.titleFromMedia(result.MediaType, result.ID,
			result.Title, result.Name, result.OriginalTitle, result.OriginalName,
			result.ReleaseDate, result.FirstAirDate, result.Overview,
			result.PosterPath, result.BackdropPath, result.OriginalLanguage, result.GenreIDs))
	}
	return titles, nil
}

func (p *TMDb) titleFromMedia(mediaType string, id int64, title, name, originalTitle, originalName,
	releaseDate, firstAirDate, overview, posterPath, backdropPath, originalLanguage string, genreIDs []int) Title {
	display, original := title, originalTitle
	date := releaseDate
	if mediaType == "tv" {
		display, original = name, originalName
		date = firstAirDate
	}
	artwork := map[string]string{}
	if posterPath != "" {
		artwork["poster"] = "https://image.tmdb.org/t/p/w342" + posterPath
	}
	if backdropPath != "" {
		artwork["background"] = "https://image.tmdb.org/t/p/w780" + backdropPath
	}
	kind := TypeMovie
	if mediaType == "tv" {
		kind = TypeSeries
		if originalLanguage == "ja" && containsInt(genreIDs, 16) {
			kind = TypeAnime
		}
	}
	return Title{
		ID:            "tmdb:" + strconv.FormatInt(id, 10),
		Type:          kind,
		Title:         display,
		OriginalTitle: original,
		Year:          yearFromDate(date),
		Overview:      overview,
		Artwork:       artwork,
		ProviderIDs:   map[string]string{"tmdb": strconv.FormatInt(id, 10)},
		MergedFrom:    []string{"tmdb"},
	}
}

func containsInt(values []int, want int) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func yearFromDate(date string) int {
	if len(date) < 4 {
		return 0
	}
	year, err := strconv.Atoi(date[:4])
	if err != nil {
		return 0
	}
	return year
}

type tmdbDetailResponse struct {
	ID             int64  `json:"id"`
	Title          string `json:"title"`
	Name           string `json:"name"`
	OriginalTitle  string `json:"original_title"`
	OriginalName   string `json:"original_name"`
	ReleaseDate    string `json:"release_date"`
	FirstAirDate   string `json:"first_air_date"`
	Overview       string `json:"overview"`
	PosterPath     string `json:"poster_path"`
	BackdropPath   string `json:"backdrop_path"`
	Runtime        int    `json:"runtime"`
	EpisodeRunTime []int  `json:"episode_run_time"`
	Genres         []struct {
		Name string `json:"name"`
	} `json:"genres"`
	Homepage         string `json:"homepage"`
	OriginalLanguage string `json:"original_language"`
	Seasons          []struct {
		SeasonNumber int    `json:"season_number"`
		Name         string `json:"name"`
		EpisodeCount int    `json:"episode_count"`
		AirDate      string `json:"air_date"`
		PosterPath   string `json:"poster_path"`
	} `json:"seasons"`
}

// Detail resolves a tmdb:<id> title, trying the movie endpoint first, then
// TV (deterministic; ids are not self-describing).
func (p *TMDb) Detail(ctx context.Context, request DetailRequest) (Title, error) {
	if p.apiKey == "" {
		return Title{}, errProviderUnavailable
	}
	externalID := request.ProviderIDs["tmdb"]
	if externalID == "" {
		return Title{}, ErrNotFound
	}
	var payload tmdbDetailResponse
	movieErr := fetchJSON(ctx, p.http, p.endpoint("/3/movie/"+externalID, nil), &payload)
	if movieErr == nil {
		return p.detailToTitle("movie", externalID, payload), nil
	}
	if movieErr != ErrNotFound {
		return Title{}, movieErr
	}
	payload = tmdbDetailResponse{}
	tvErr := fetchJSON(ctx, p.http, p.endpoint("/3/tv/"+externalID, nil), &payload)
	if tvErr == nil {
		return p.detailToTitle("tv", externalID, payload), nil
	}
	return Title{}, ErrNotFound
}

func (p *TMDb) detailToTitle(mediaType, externalID string, payload tmdbDetailResponse) Title {
	title := p.titleFromMedia(mediaType, payload.ID,
		payload.Title, payload.Name, payload.OriginalTitle, payload.OriginalName,
		payload.ReleaseDate, payload.FirstAirDate, payload.Overview,
		payload.PosterPath, payload.BackdropPath, payload.OriginalLanguage, nil)
	if payload.Runtime > 0 {
		title.Runtime = payload.Runtime
	} else if len(payload.EpisodeRunTime) > 0 {
		title.Runtime = payload.EpisodeRunTime[0]
	}
	for _, genre := range payload.Genres {
		title.Genres = append(title.Genres, genre.Name)
	}
	if payload.Homepage != "" {
		title.ExternalLinks = map[string]string{"homepage": payload.Homepage}
	}
	if mediaType == "tv" {
		for _, season := range payload.Seasons {
			// Same shape the renderer consumed from the TMDb raw payload:
			// numbered seasons with episodes only (specials keep number 0).
			if season.SeasonNumber < 0 || (season.EpisodeCount == 0 && season.AirDate == "") {
				continue
			}
			summary := Season{
				Number:       season.SeasonNumber,
				Name:         season.Name,
				EpisodeCount: season.EpisodeCount,
				AirDate:      season.AirDate,
			}
			if season.PosterPath != "" {
				summary.Poster = "https://image.tmdb.org/t/p/w342" + season.PosterPath
			}
			title.Seasons = append(title.Seasons, summary)
		}
		sort.SliceStable(title.Seasons, func(i, j int) bool {
			return title.Seasons[i].Number < title.Seasons[j].Number
		})
	}
	return title
}

type tmdbSeasonResponse struct {
	Season   int `json:"season_number"`
	Episodes []struct {
		EpisodeNumber int    `json:"episode_number"`
		SeasonNumber  int    `json:"season_number"`
		Name          string `json:"name"`
		AirDate       string `json:"air_date"`
		StillPath     string `json:"still_path"`
		Overview      string `json:"overview"`
		Runtime       int    `json:"runtime"`
	} `json:"episodes"`
}

func (p *TMDb) Episodes(ctx context.Context, request EpisodeRequest) ([]Episode, error) {
	if p.apiKey == "" {
		return nil, errProviderUnavailable
	}
	externalID := request.ProviderIDs["tmdb"]
	if externalID == "" {
		return nil, ErrNotFound
	}
	var payload tmdbSeasonResponse
	endpoint := p.endpoint("/3/tv/"+externalID+"/season/"+strconv.Itoa(request.Season), nil)
	if err := fetchJSON(ctx, p.http, endpoint, &payload); err != nil {
		return nil, err
	}
	episodes := make([]Episode, 0, len(payload.Episodes))
	for _, episode := range payload.Episodes {
		still := ""
		if episode.StillPath != "" {
			still = "https://image.tmdb.org/t/p/w300" + episode.StillPath
		}
		episodes = append(episodes, Episode{
			ID:          "tmdb:" + externalID + ":" + strconv.Itoa(episode.SeasonNumber) + ":" + strconv.Itoa(episode.EpisodeNumber),
			Season:      episode.SeasonNumber,
			Episode:     episode.EpisodeNumber,
			Title:       episode.Name,
			AirDate:     episode.AirDate,
			Still:       still,
			Overview:    episode.Overview,
			DurationS:   episode.Runtime * 60,
			ProviderIDs: map[string]string{"tmdb": externalID},
		})
	}
	return episodes, nil
}

func (p *TMDb) Section(ctx context.Context, kind string) ([]Title, error) {
	if p.apiKey == "" {
		return nil, errProviderUnavailable
	}
	path := ""
	switch kind {
	case "trending":
		path = "/3/trending/all/day"
	case "popular":
		path = "/3/trending/all/week"
	default:
		return nil, ErrNotFound
	}
	var payload tmdbSearchResponse
	if err := fetchJSON(ctx, p.http, p.endpoint(path, nil), &payload); err != nil {
		return nil, err
	}
	titles := make([]Title, 0, len(payload.Results))
	for _, result := range payload.Results {
		if result.MediaType != "movie" && result.MediaType != "tv" {
			continue
		}
		titles = append(titles, p.titleFromMedia(result.MediaType, result.ID,
			result.Title, result.Name, result.OriginalTitle, result.OriginalName,
			result.ReleaseDate, result.FirstAirDate, result.Overview,
			result.PosterPath, result.BackdropPath, result.OriginalLanguage, result.GenreIDs))
	}
	return titles, nil
}

// SectionPage implements PageableSectionProvider: the curated trending/
// popular sections requested beyond their first page (T042.1). TMDb's
// trending endpoints accept a page parameter; total_pages comes back in the
// same payload.
func (p *TMDb) SectionPage(ctx context.Context, kind string, page int) ([]Title, int, error) {
	if p.apiKey == "" {
		return nil, 0, errProviderUnavailable
	}
	path := ""
	switch kind {
	case "trending":
		path = "/3/trending/all/day"
	case "popular":
		path = "/3/trending/all/week"
	default:
		return nil, 0, ErrNotFound
	}
	var payload tmdbSearchResponse
	if err := fetchJSON(ctx, p.http, p.endpoint(path, map[string]string{"page": strconv.Itoa(page)}), &payload); err != nil {
		return nil, 0, err
	}
	titles, err := p.titlesFromSearchResults(payload)
	return titles, payload.TotalPages, err
}

// GenreSection implements GenreSectionProvider: media-type scoped discover
// queries for one TMDb genre id, paged (renderer genre rails, T042.1).
func (p *TMDb) GenreSection(ctx context.Context, mediaType TitleType, genreID, page int) ([]Title, int, error) {
	if p.apiKey == "" {
		return nil, 0, errProviderUnavailable
	}
	var path string
	switch mediaType {
	case TypeMovie:
		path = "/3/discover/movie"
	case TypeSeries:
		path = "/3/discover/tv"
	default:
		return nil, 0, ErrNotFound
	}
	var payload tmdbSearchResponse
	params := map[string]string{
		"with_genres": strconv.Itoa(genreID),
		"page":        strconv.Itoa(page),
		"sort_by":     "popularity.desc",
	}
	if err := fetchJSON(ctx, p.http, p.endpoint(path, params), &payload); err != nil {
		return nil, 0, err
	}
	titles, err := p.titlesFromDiscoverResults(payload, mediaType)
	return titles, payload.TotalPages, err
}

func (p *TMDb) titlesFromSearchResults(payload tmdbSearchResponse) ([]Title, error) {
	titles := make([]Title, 0, len(payload.Results))
	for _, result := range payload.Results {
		if result.MediaType != "movie" && result.MediaType != "tv" {
			continue
		}
		titles = append(titles, p.titleFromMedia(result.MediaType, result.ID,
			result.Title, result.Name, result.OriginalTitle, result.OriginalName,
			result.ReleaseDate, result.FirstAirDate, result.Overview,
			result.PosterPath, result.BackdropPath, result.OriginalLanguage, result.GenreIDs))
	}
	return titles, nil
}

func (p *TMDb) titlesFromDiscoverResults(payload tmdbSearchResponse, mediaType TitleType) ([]Title, error) {
	kind := "movie"
	if mediaType == TypeSeries {
		kind = "tv"
	}
	titles := make([]Title, 0, len(payload.Results))
	for _, result := range payload.Results {
		titles = append(titles, p.titleFromMedia(kind, result.ID,
			result.Title, result.Name, result.OriginalTitle, result.OriginalName,
			result.ReleaseDate, result.FirstAirDate, result.Overview,
			result.PosterPath, result.BackdropPath, result.OriginalLanguage, result.GenreIDs))
	}
	return titles, nil
}
