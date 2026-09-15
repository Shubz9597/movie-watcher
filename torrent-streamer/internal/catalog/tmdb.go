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
	Results    []struct {
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

// splitTMDbExternalID splits a TMDb external id that may carry an explicit
// media qualifier ("movie:123" / "tv:123", from the qualified canonical ids
// tmdb:movie:N / tmdb:tv:N, M3.1.1) away from the legacy unqualified numeric
// form. The qualifier selects exactly ONE upstream endpoint for Detail; the
// legacy form keeps the documented movie→tv probe order as a read alias.
func splitTMDbExternalID(externalID string) (mediaType, numericID string) {
	if rest, ok := strings.CutPrefix(externalID, "movie:"); ok {
		return "movie", rest
	}
	if rest, ok := strings.CutPrefix(externalID, "tv:"); ok {
		return "tv", rest
	}
	return "", externalID
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
	// M3.1.1: TMDb canonical ids are media-qualified ("tmdb:movie:N" /
	// "tmdb:tv:N") because movie and tv numeric sequences are independent
	// upstream. Anime keeps its structural media type in the id (classification
	// is not a third namespace). The ProviderIDs value mirrors the qualified
	// external id so Detail/Episodes address one endpoint deterministically.
	qualifiedID := mediaType + ":" + strconv.FormatInt(id, 10)
	return Title{
		ID:            "tmdb:" + qualifiedID,
		Type:          kind,
		Title:         display,
		OriginalTitle: original,
		Year:          yearFromDate(date),
		Overview:      overview,
		Artwork:       artwork,
		ProviderIDs:   map[string]string{"tmdb": qualifiedID},
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
	// Images (append_to_response=images): title logos power the mobile
	// player's buffering overlay (Stremio-style reveal). English or
	// language-less logos are preferred; any logo beats none.
	Images struct {
		Logos []struct {
			FilePath string `json:"file_path"`
			Iso639_1 string `json:"iso_639_1"`
		} `json:"logos"`
	} `json:"images"`
	// AlternativeTitles (append_to_response=alternative_titles): romaji and
	// AKA titles feed torrent search — anime indexers file releases under the
	// romaji title, not the localized display title.
	AlternativeTitles struct {
		Results []struct {
			Title string `json:"title"`
		} `json:"results"`
		Titles []struct {
			Title string `json:"title"`
		} `json:"titles"`
	} `json:"alternative_titles"`
}

// Detail resolves a tmdb:<id> title. Qualified external ids ("movie:N" /
// "tv:N", from the canonical ids tmdb:movie:N / tmdb:tv:N) probe ONLY the
// requested media-type endpoint — a qualified tv lookup never falls back to
// the movie endpoint (M3.1.1 identity contract). The legacy unqualified
// numeric form stays a read alias with the documented deterministic movie→tv
// probe order (ids are not self-describing).
func (p *TMDb) Detail(ctx context.Context, request DetailRequest) (Title, error) {
	if p.apiKey == "" {
		return Title{}, errProviderUnavailable
	}
	mediaType, externalID := splitTMDbExternalID(request.ProviderIDs["tmdb"])
	if externalID == "" {
		return Title{}, ErrNotFound
	}
	var payload tmdbDetailResponse
	// Images ride along with every detail fetch (logo artwork for the player
	// buffering overlay); one extra upstream field, no second request.
	detailParams := map[string]string{"append_to_response": "images,alternative_titles", "include_image_language": "en,null"}
	if mediaType == "" {
		movieErr := fetchJSON(ctx, p.http, p.endpoint("/3/movie/"+externalID, detailParams), &payload)
		if movieErr == nil {
			return p.detailToTitle("movie", externalID, payload), nil
		}
		if movieErr != ErrNotFound {
			return Title{}, movieErr
		}
		payload = tmdbDetailResponse{}
		tvErr := fetchJSON(ctx, p.http, p.endpoint("/3/tv/"+externalID, detailParams), &payload)
		if tvErr == nil {
			return p.detailToTitle("tv", externalID, payload), nil
		}
		return Title{}, ErrNotFound
	}
	path := "/3/movie/"
	if mediaType == "tv" {
		path = "/3/tv/"
	}
	if err := fetchJSON(ctx, p.http, p.endpoint(path+externalID, detailParams), &payload); err != nil {
		return Title{}, err
	}
	return p.detailToTitle(mediaType, externalID, payload), nil
}

func (p *TMDb) detailToTitle(mediaType, externalID string, payload tmdbDetailResponse) Title {
	title := p.titleFromMedia(mediaType, payload.ID,
		payload.Title, payload.Name, payload.OriginalTitle, payload.OriginalName,
		payload.ReleaseDate, payload.FirstAirDate, payload.Overview,
		payload.PosterPath, payload.BackdropPath, payload.OriginalLanguage, nil)
	// Title logo for the player's buffering overlay: prefer an English or
	// language-less logo, then any logo at all.
	var fallbackLogo string
	for _, logo := range payload.Images.Logos {
		if logo.FilePath == "" {
			continue
		}
		if logo.Iso639_1 == "en" || logo.Iso639_1 == "" {
			fallbackLogo = logo.FilePath
			break
		}
		if fallbackLogo == "" {
			fallbackLogo = logo.FilePath
		}
	}
	if fallbackLogo != "" {
		title.Artwork["logo"] = "https://image.tmdb.org/t/p/w500" + fallbackLogo
	}
	// Alternative titles feed torrent search: anime indexers file releases
	// under the romaji title, which usually differs from the display title.
	seenTitles := map[string]struct{}{strings.ToLower(title.Title): {}, strings.ToLower(title.OriginalTitle): {}}
	addAltTitle := func(raw string) {
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" {
			return
		}
		// Torrent queries are capped (maxSearches): drop non-Latin-script
		// translations (CJK/Cyrillic/Hangul) so the romaji/ASCII variants —
		// the ones torrent indexers actually index — land within the budget.
		for _, r := range trimmed {
			if r >= 0x0400 { // Cyrillic and everything East Asian above it
				return
			}
		}
		key := strings.ToLower(trimmed)
		if _, dup := seenTitles[key]; dup {
			return
		}
		seenTitles[key] = struct{}{}
		title.AltTitles = append(title.AltTitles, trimmed)
	}
	for _, row := range payload.AlternativeTitles.Results {
		addAltTitle(row.Title)
	}
	for _, row := range payload.AlternativeTitles.Titles {
		addAltTitle(row.Title)
	}
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
	// Episodes always resolve through the tv endpoint; a qualified external
	// id ("tv:123") is expected from qualified canonical ids, the bare
	// numeric form stays the legacy alias input. Episode ids embed the
	// requested title-id form so the namespace follows the title (M3.1.1).
	qualifiedExternal := request.ProviderIDs["tmdb"]
	_, externalID := splitTMDbExternalID(qualifiedExternal)
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
			ID:          "tmdb:" + qualifiedExternal + ":" + strconv.Itoa(episode.SeasonNumber) + ":" + strconv.Itoa(episode.EpisodeNumber),
			Season:      episode.SeasonNumber,
			Episode:     episode.EpisodeNumber,
			Title:       episode.Name,
			AirDate:     episode.AirDate,
			Still:       still,
			Overview:    episode.Overview,
			DurationS:   episode.Runtime * 60,
			ProviderIDs: map[string]string{"tmdb": qualifiedExternal},
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

// CandidateProvider supplies popular candidates WITH genre names for
// recommendation scoring (M4.1, contracts/recommendations-api.md). The
// upstream cost is bounded per build: a handful of trending pages plus the
// two genre-list lookups — never one call per candidate.
type CandidateProvider interface {
	Provider
	// PopularCandidates returns up to limit popular titles ordered by the
	// provider's popularity (rank = slice position).
	PopularCandidates(ctx context.Context, limit int) ([]Title, error)
}

type tmdbGenreListResponse struct {
	Genres []struct {
		ID   int    `json:"id"`
		Name string `json:"name"`
	} `json:"genres"`
}

// PopularCandidates merges the weekly trending pages (popularity order) and
// maps each result's numeric genre ids onto names via the TMDb genre lists so
// candidates carry genre metadata without a detail call per candidate.
func (p *TMDb) PopularCandidates(ctx context.Context, limit int) ([]Title, error) {
	if p.apiKey == "" {
		return nil, errProviderUnavailable
	}
	var movieGenres, tvGenres tmdbGenreListResponse
	if err := fetchJSON(ctx, p.http, p.endpoint("/3/genre/movie/list", nil), &movieGenres); err != nil {
		return nil, err
	}
	if err := fetchJSON(ctx, p.http, p.endpoint("/3/genre/tv/list", nil), &tvGenres); err != nil {
		return nil, err
	}
	genreName := map[int]string{}
	for _, genre := range append(movieGenres.Genres, tvGenres.Genres...) {
		genreName[genre.ID] = genre.Name
	}

	titles := make([]Title, 0, limit)
	// Deduplication key is the QUALIFIED media identity (media type + numeric
	// id): TMDb movie and tv numeric sequences are independent, so the same
	// number in both namespaces is two different titles and must NOT collapse.
	seen := map[string]bool{}
	for page := 1; len(titles) < limit && page <= 5; page++ {
		var payload tmdbSearchResponse
		if err := fetchJSON(ctx, p.http, p.endpoint("/3/trending/all/week", map[string]string{"page": strconv.Itoa(page)}), &payload); err != nil {
			return nil, err
		}
		for _, result := range payload.Results {
			if result.MediaType != "movie" && result.MediaType != "tv" {
				continue
			}
			key := result.MediaType + ":" + strconv.FormatInt(result.ID, 10)
			if seen[key] {
				continue
			}
			seen[key] = true
			title := p.titleFromMedia(result.MediaType, result.ID,
				result.Title, result.Name, result.OriginalTitle, result.OriginalName,
				result.ReleaseDate, result.FirstAirDate, result.Overview,
				result.PosterPath, result.BackdropPath, result.OriginalLanguage, result.GenreIDs)
			for _, genreID := range result.GenreIDs {
				if name, ok := genreName[genreID]; ok && name != "" {
					title.Genres = append(title.Genres, name)
				}
			}
			titles = append(titles, title)
			if len(titles) >= limit {
				break
			}
		}
		if len(payload.Results) == 0 {
			break
		}
	}
	return titles, nil
}
