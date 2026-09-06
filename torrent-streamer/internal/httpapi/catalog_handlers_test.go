package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"torrent-streamer/internal/buildinfo"
	"torrent-streamer/internal/catalog"
	"torrent-streamer/internal/imdb"
)

func TestProviderSectionIncludesSummariesWithoutDetailCalls(t *testing.T) {
	for _, degraded := range []bool{false, true} {
		t.Run(map[bool]string{false: "healthy", true: "degraded"}[degraded], func(t *testing.T) {
			provider := &fakeCatalogProvider{name: "tmdb", sectionFn: func(context.Context, string) ([]catalog.Title, error) {
				return []catalog.Title{{ID: "tmdb:100", Type: catalog.TypeMovie, Title: "Movie", Year: 2024,
					Artwork: map[string]string{"poster": "https://example.test/poster.jpg"}, ProviderIDs: map[string]string{"tmdb": "100"}}}, nil
			}, detailFn: func(context.Context, catalog.DetailRequest) (catalog.Title, error) {
				t.Error("section loading must not request title detail")
				return catalog.Title{}, catalog.ErrNotFound
			}}
			providers := []catalog.Provider{provider}
			if degraded {
				providers = append(providers, &fakeCatalogProvider{name: "down"})
			}
			h := CatalogHandlers{Catalog: catalog.NewService(providers, catalog.Options{})}
			mux := http.NewServeMux()
			h.Register(mux)
			recorder := httptest.NewRecorder()
			mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v2/catalog/sections?kind=trending", nil))
			var response struct {
				TitleIDs []string        `json:"titleIds"`
				Results  []catalog.Title `json:"results"`
				Degraded bool            `json:"degraded"`
			}
			if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			if recorder.Code != http.StatusOK || len(response.Results) != 1 || len(response.TitleIDs) != 1 {
				t.Fatalf("section = %d %s", recorder.Code, recorder.Body.String())
			}
			if response.Results[0].ID != response.TitleIDs[0] || response.Results[0].Artwork["poster"] == "" || response.Degraded != degraded {
				t.Fatalf("section summaries lost metadata or degradation: %+v", response)
			}
		})
	}
}

func TestEmptyProviderSectionIncludesEmptySummaries(t *testing.T) {
	h := CatalogHandlers{Catalog: catalog.NewService(nil, catalog.Options{})}
	mux := http.NewServeMux()
	h.Register(mux)
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v2/catalog/sections?kind=trending", nil))
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"results":[]`) {
		t.Fatalf("empty section = %d %s", recorder.Code, recorder.Body.String())
	}
}

type fakePagedCatalogProvider struct {
	fakeCatalogProvider
	pagedSectionFn func(ctx context.Context, kind string, page int) ([]catalog.Title, int, error)
	genreSectionFn func(ctx context.Context, mediaType catalog.TitleType, genreID, page int) ([]catalog.Title, int, error)
}

func (f *fakePagedCatalogProvider) SectionPage(ctx context.Context, kind string, page int) ([]catalog.Title, int, error) {
	if f.pagedSectionFn == nil {
		return nil, 0, errors.New("not supported")
	}
	return f.pagedSectionFn(ctx, kind, page)
}

func (f *fakePagedCatalogProvider) GenreSection(ctx context.Context, mediaType catalog.TitleType, genreID, page int) ([]catalog.Title, int, error) {
	if f.genreSectionFn == nil {
		return nil, 0, errors.New("not supported")
	}
	return f.genreSectionFn(ctx, mediaType, genreID, page)
}

func TestSectionPageForwardsPageAndSurfacesTotalPages(t *testing.T) {
	provider := &fakePagedCatalogProvider{fakeCatalogProvider: fakeCatalogProvider{name: "tmdb"},
		pagedSectionFn: func(_ context.Context, kind string, page int) ([]catalog.Title, int, error) {
			if kind != "popular" || page != 2 {
				t.Fatalf("section request = %q page %d, want popular/2", kind, page)
			}
			return []catalog.Title{{ID: "tmdb:200", Type: catalog.TypeMovie, Title: "Paged", ProviderIDs: map[string]string{"tmdb": "200"}}}, 9, nil
		}}
	h := CatalogHandlers{Catalog: catalog.NewService([]catalog.Provider{provider}, catalog.Options{})}
	mux := http.NewServeMux()
	h.Register(mux)
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v2/catalog/sections?kind=popular&page=2", nil))
	var response struct {
		Page       int             `json:"page"`
		TotalPages int             `json:"totalPages"`
		Results    []catalog.Title `json:"results"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if recorder.Code != http.StatusOK || response.Page != 2 || response.TotalPages != 9 || len(response.Results) != 1 {
		t.Fatalf("paged section = %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestSectionGenreRoutesToGenreProviders(t *testing.T) {
	provider := &fakePagedCatalogProvider{fakeCatalogProvider: fakeCatalogProvider{name: "tmdb"},
		genreSectionFn: func(_ context.Context, mediaType catalog.TitleType, genreID, page int) ([]catalog.Title, int, error) {
			if mediaType != catalog.TypeMovie || genreID != 28 || page != 1 {
				t.Fatalf("genre request = %q/%d page %d", mediaType, genreID, page)
			}
			return []catalog.Title{{ID: "tmdb:300", Type: catalog.TypeMovie, Title: "Action", ProviderIDs: map[string]string{"tmdb": "300"}}}, 4, nil
		}}
	h := CatalogHandlers{Catalog: catalog.NewService([]catalog.Provider{provider}, catalog.Options{})}
	mux := http.NewServeMux()
	h.Register(mux)
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v2/catalog/sections?kind=popular&genre=28&type=movie", nil))
	var response struct {
		TotalPages int             `json:"totalPages"`
		Results    []catalog.Title `json:"results"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if recorder.Code != http.StatusOK || response.TotalPages != 4 || len(response.Results) != 1 || response.Results[0].ID != "tmdb:300" {
		t.Fatalf("genre section = %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestSectionParameterValidation(t *testing.T) {
	h := CatalogHandlers{Catalog: catalog.NewService(nil, catalog.Options{})}
	mux := http.NewServeMux()
	h.Register(mux)
	for name, query := range map[string]string{
		"page too low":            "kind=trending&page=0",
		"page not integer":        "kind=trending&page=two",
		"page too high":           "kind=trending&page=501",
		"genre not int":           "kind=trending&genre=action",
		"genre without type":      "kind=trending&genre=28",
		"type without genre":      "kind=trending&type=movie",
		"anime genre unsupported": "kind=trending&genre=28&type=anime",
	} {
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v2/catalog/sections?"+query, nil))
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("%s: = %d %s, want 400", name, recorder.Code, recorder.Body.String())
		}
	}
}

func TestTitleDetailIncludesSeasons(t *testing.T) {
	provider := &fakeCatalogProvider{name: "tmdb", detailFn: func(context.Context, catalog.DetailRequest) (catalog.Title, error) {
		return catalog.Title{ID: "tmdb:209867", Type: catalog.TypeSeries, Title: "Frieren",
			Seasons:     []catalog.Season{{Number: 1, Name: "Season 1", EpisodeCount: 28}},
			ProviderIDs: map[string]string{"tmdb": "209867"}}, nil
	}}
	h := CatalogHandlers{Catalog: catalog.NewService([]catalog.Provider{provider}, catalog.Options{})}
	mux := http.NewServeMux()
	h.Register(mux)
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v2/catalog/titles/tmdb:209867", nil))
	var response struct {
		Seasons []catalog.Season `json:"seasons"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if recorder.Code != http.StatusOK || len(response.Seasons) != 1 || response.Seasons[0].EpisodeCount != 28 {
		t.Fatalf("detail seasons = %d %s", recorder.Code, recorder.Body.String())
	}
}

type fakeCatalogProvider struct {
	name      string
	searchFn  func(ctx context.Context, query catalog.SearchQuery) ([]catalog.Title, error)
	detailFn  func(ctx context.Context, request catalog.DetailRequest) (catalog.Title, error)
	episodeFn func(ctx context.Context, request catalog.EpisodeRequest) ([]catalog.Episode, error)
	sectionFn func(ctx context.Context, kind string) ([]catalog.Title, error)
}

func (f *fakeCatalogProvider) Name() string { return f.name }

func (f *fakeCatalogProvider) Search(ctx context.Context, query catalog.SearchQuery) ([]catalog.Title, error) {
	if f.searchFn == nil {
		return nil, errors.New("not supported")
	}
	return f.searchFn(ctx, query)
}

func (f *fakeCatalogProvider) Detail(ctx context.Context, request catalog.DetailRequest) (catalog.Title, error) {
	if f.detailFn == nil {
		return catalog.Title{}, errors.New("not supported")
	}
	return f.detailFn(ctx, request)
}

func (f *fakeCatalogProvider) Episodes(ctx context.Context, request catalog.EpisodeRequest) ([]catalog.Episode, error) {
	if f.episodeFn == nil {
		return nil, errors.New("not supported")
	}
	return f.episodeFn(ctx, request)
}

func (f *fakeCatalogProvider) Section(ctx context.Context, kind string) ([]catalog.Title, error) {
	if f.sectionFn == nil {
		return nil, errors.New("not supported")
	}
	return f.sectionFn(ctx, kind)
}

type fakeRatings struct{ rating imdb.Rating }

func (f fakeRatings) Rating(context.Context, string) (imdb.Rating, error) {
	return f.rating, nil
}

func newCatalogTestMux(searchFn func(ctx context.Context, query catalog.SearchQuery) ([]catalog.Title, error)) (*http.ServeMux, CatalogHandlers) {
	build := buildinfo.New(buildinfo.Options{
		ServerVersion: "2.0.0-test",
		Capabilities:  []string{"catalog.bff.v2"},
	})
	provider := &fakeCatalogProvider{name: "stub", searchFn: searchFn}
	handlers := CatalogHandlers{
		Catalog: catalog.NewService([]catalog.Provider{provider}, catalog.Options{ProviderTimeout: 100 * time.Millisecond}),
		Build:   build,
		Ratings: fakeRatings{rating: imdb.Rating{IMDbID: "tt28015436", Rating: 8.9, Votes: 12345}},
	}
	mux := http.NewServeMux()
	handlers.Register(mux)
	return mux, handlers
}

func TestCatalogSearchContract(t *testing.T) {
	mux, _ := newCatalogTestMux(func(ctx context.Context, query catalog.SearchQuery) ([]catalog.Title, error) {
		return []catalog.Title{{
			ID: "tmdb:209867", Type: catalog.TypeAnime, Title: "Frieren: Beyond Journey's End",
			Year: 2023, Overview: "overview",
			Artwork:     map[string]string{"poster": "https://poster.png"},
			ProviderIDs: map[string]string{"tmdb": "209867"},
			MergedFrom:  []string{"tmdb"},
		}}, nil
	})

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v2/catalog/search?q=frieren&type=all&clientId=11111111-1111-4111-8111-111111111111", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	payload := decodeBody(t, recorder)
	if payload["query"] != "frieren" || payload["total"] != float64(1) || payload["degraded"] != false {
		t.Fatalf("search payload wrong: %s", recorder.Body.String())
	}
	if empty, ok := payload["degradedProviders"].([]any); !ok || len(empty) != 0 {
		t.Fatalf("degradedProviders must be an empty array: %v", payload["degradedProviders"])
	}
	results, _ := payload["results"].([]any)
	first, _ := results[0].(map[string]any)
	if first["id"] != "tmdb:209867" || first["type"] != "anime" || first["year"] != float64(2023) {
		t.Fatalf("result mapping wrong: %v", first)
	}
	providerIDs, _ := first["providerIds"].(map[string]any)
	if providerIDs["tmdb"] != "209867" {
		t.Fatalf("providerIds wrong: %v", providerIDs)
	}
}

func TestCatalogSearchValidation(t *testing.T) {
	mux, _ := newCatalogTestMux(func(ctx context.Context, query catalog.SearchQuery) ([]catalog.Title, error) {
		return nil, nil
	})
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v2/catalog/search", nil))
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "invalid_request") {
		t.Fatalf("missing q = %d %s", recorder.Code, recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v2/catalog/search?q=x&type=bogus", nil))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("bad type = %d", recorder.Code)
	}

	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v2/catalog/search?q=x&clientId=not-a-uuid", nil))
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "invalid_client_id") {
		t.Fatalf("bad clientId = %d %s", recorder.Code, recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/v2/catalog/search?q=x", nil))
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST search = %d", recorder.Code)
	}
}

func TestCatalogSearchDegradationAndAllProviderFailure(t *testing.T) {
	upFn := func(ctx context.Context, query catalog.SearchQuery) ([]catalog.Title, error) {
		return []catalog.Title{{ID: "anilist:1", Type: catalog.TypeAnime, Title: "Up", ProviderIDs: map[string]string{"anilist": "1"}, MergedFrom: []string{"anilist"}}}, nil
	}
	downFn := func(ctx context.Context, query catalog.SearchQuery) ([]catalog.Title, error) {
		return nil, errors.New("down")
	}
	build := buildinfo.New(buildinfo.Options{ServerVersion: "2.0.0-test", Capabilities: []string{"catalog.bff.v2"}})
	handlers := CatalogHandlers{
		Catalog: catalog.NewService([]catalog.Provider{
			&fakeCatalogProvider{name: "up", searchFn: upFn},
			&fakeCatalogProvider{name: "down", searchFn: downFn},
		}, catalog.Options{ProviderTimeout: 50 * time.Millisecond}),
		Build: build,
	}
	mux := http.NewServeMux()
	handlers.Register(mux)

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v2/catalog/search?q=x", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("partial outage status = %d", recorder.Code)
	}
	payload := decodeBody(t, recorder)
	if payload["degraded"] != true {
		t.Fatalf("degraded flag missing: %s", recorder.Body.String())
	}
	degraded, _ := payload["degradedProviders"].([]any)
	if len(degraded) != 1 || degraded[0] != "down" {
		t.Fatalf("degradedProviders = %v", payload["degradedProviders"])
	}

	allDown := CatalogHandlers{
		Catalog: catalog.NewService([]catalog.Provider{
			&fakeCatalogProvider{name: "down", searchFn: downFn},
		}, catalog.Options{ProviderTimeout: 50 * time.Millisecond}),
		Build: build,
	}
	mux = http.NewServeMux()
	allDown.Register(mux)
	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v2/catalog/search?q=x", nil))
	if recorder.Code != http.StatusServiceUnavailable || !strings.Contains(recorder.Body.String(), "providers_unavailable") {
		t.Fatalf("all-failed = %d %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"degradedProviders":["down"]`) {
		t.Fatalf("providers_unavailable must carry degradedProviders: %s", recorder.Body.String())
	}
}

func TestCatalogNegotiationEnforcement(t *testing.T) {
	mux, _ := newCatalogTestMux(func(ctx context.Context, query catalog.SearchQuery) ([]catalog.Title, error) {
		return nil, nil
	})
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/v2/catalog/search?q=x", nil)
	request.Header.Set("X-Torwatch-Protocol", "9")
	mux.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), `"code":"unsupported_protocol"`) {
		t.Fatalf("protocol enforcement = %d %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"supportedProtocolRange":[1,1]`) {
		t.Fatalf("server range missing: %s", recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodGet, "/v2/catalog/search?q=x", nil)
	request.Header.Set("X-Torwatch-Capability", "time.travel")
	mux.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), `"code":"unsupported_capability"`) {
		t.Fatalf("capability enforcement = %d %s", recorder.Code, recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodGet, "/v2/catalog/search?q=x", nil)
	request.Header.Set("X-Torwatch-Protocol", "1")
	request.Header.Set("X-Torwatch-Capability", "catalog.bff.v2")
	mux.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("valid negotiation rejected: %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestCatalogTitleDetailContract(t *testing.T) {
	build := buildinfo.New(buildinfo.Options{ServerVersion: "2.0.0-test", Capabilities: []string{"catalog.bff.v2"}})
	handlers := CatalogHandlers{
		Catalog: catalog.NewService([]catalog.Provider{
			&fakeCatalogProvider{name: "stub", detailFn: func(ctx context.Context, request catalog.DetailRequest) (catalog.Title, error) {
				if request.ProviderIDs["tmdb"] == "999999" {
					return catalog.Title{}, catalog.ErrNotFound
				}
				return catalog.Title{
					ID: "tmdb:209867", Type: catalog.TypeAnime, Title: "Frieren", IMDBID: "tt28015436",
					ProviderIDs: map[string]string{"tmdb": "209867"}, MergedFrom: []string{"tmdb"},
				}, nil
			}},
		}, catalog.Options{ProviderTimeout: 50 * time.Millisecond}),
		Build:   build,
		Ratings: fakeRatings{rating: imdb.Rating{IMDbID: "tt28015436", Rating: 8.9, Votes: 12345}},
	}
	detailMux := http.NewServeMux()
	handlers.Register(detailMux)

	recorder := httptest.NewRecorder()
	detailMux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v2/catalog/titles/tmdb:209867", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	payload := decodeBody(t, recorder)
	if payload["id"] != "tmdb:209867" {
		t.Fatalf("detail payload wrong: %s", recorder.Body.String())
	}
	ratings, _ := payload["ratings"].(map[string]any)
	imdbRating, _ := ratings["imdb"].(map[string]any)
	if imdbRating["rating"] != 8.9 || imdbRating["votes"] != float64(12345) {
		t.Fatalf("imdb rating wrong: %v", ratings)
	}

	recorder = httptest.NewRecorder()
	detailMux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v2/catalog/titles/tmdb:999999", nil))
	if recorder.Code != http.StatusNotFound || !strings.Contains(recorder.Body.String(), "title_not_found") {
		t.Fatalf("404 = %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestCatalogTitleDetailOutageIsProvidersUnavailable(t *testing.T) {
	build := buildinfo.New(buildinfo.Options{ServerVersion: "2.0.0-test", Capabilities: []string{"catalog.bff.v2"}})
	handlers := CatalogHandlers{
		Catalog: catalog.NewService([]catalog.Provider{
			&fakeCatalogProvider{name: "down", detailFn: func(ctx context.Context, request catalog.DetailRequest) (catalog.Title, error) {
				return catalog.Title{}, errors.New("boom")
			}},
		}, catalog.Options{ProviderTimeout: 50 * time.Millisecond}),
		Build: build,
	}
	mux := http.NewServeMux()
	handlers.Register(mux)
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v2/catalog/titles/tmdb:1", nil))
	if recorder.Code != http.StatusServiceUnavailable || !strings.Contains(recorder.Body.String(), "providers_unavailable") {
		t.Fatalf("detail outage = %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestCatalogEpisodesContract(t *testing.T) {
	build := buildinfo.New(buildinfo.Options{ServerVersion: "2.0.0-test", Capabilities: []string{"catalog.bff.v2"}})
	handlers := CatalogHandlers{
		Catalog: catalog.NewService([]catalog.Provider{
			&fakeCatalogProvider{name: "stub", episodeFn: func(ctx context.Context, request catalog.EpisodeRequest) ([]catalog.Episode, error) {
				return []catalog.Episode{{
					ID: "tmdb:209867:1:1", Season: 1, Episode: 1, Title: "The Journey's End",
					DurationS: 1440, ProviderIDs: map[string]string{"tmdb": "209867"},
				}}, nil
			}},
		}, catalog.Options{ProviderTimeout: 50 * time.Millisecond}),
		Build: build,
	}
	mux := http.NewServeMux()
	handlers.Register(mux)

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v2/catalog/titles/tmdb:209867/episodes?season=1", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	payload := decodeBody(t, recorder)
	if payload["titleId"] != "tmdb:209867" || payload["season"] != float64(1) {
		t.Fatalf("episode payload wrong: %s", recorder.Body.String())
	}
	episodes, _ := payload["episodes"].([]any)
	first, _ := episodes[0].(map[string]any)
	if first["duration_s"] != float64(1440) {
		t.Fatalf("episode fields wrong: %v", first)
	}

	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v2/catalog/titles/tmdb:209867/episodes", nil))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("missing season = %d", recorder.Code)
	}
	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v2/catalog/titles/tmdb:209867/episodes?season=-1", nil))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("negative season = %d", recorder.Code)
	}
}

func TestCatalogSectionsContract(t *testing.T) {
	build := buildinfo.New(buildinfo.Options{ServerVersion: "2.0.0-test", Capabilities: []string{"catalog.bff.v2"}})
	handlers := CatalogHandlers{
		Catalog: catalog.NewService([]catalog.Provider{
			&fakeCatalogProvider{name: "stub", sectionFn: func(ctx context.Context, kind string) ([]catalog.Title, error) {
				return []catalog.Title{
					{ID: "tmdb:2", Type: catalog.TypeMovie, Title: "B", ProviderIDs: map[string]string{"tmdb": "2"}, MergedFrom: []string{"tmdb"}},
					{ID: "tmdb:1", Type: catalog.TypeMovie, Title: "A", ProviderIDs: map[string]string{"tmdb": "1"}, MergedFrom: []string{"tmdb"}},
				}, nil
			}},
		}, catalog.Options{ProviderTimeout: 50 * time.Millisecond}),
		Build:             build,
		HouseholdContinue: func(ctx context.Context) ([]string, error) { return []string{"jikan:1"}, nil },
	}
	mux := http.NewServeMux()
	handlers.Register(mux)

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v2/catalog/sections?kind=trending", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	payload := decodeBody(t, recorder)
	if payload["id"] != "trending" || payload["kind"] != "provider" {
		t.Fatalf("section payload wrong: %s", recorder.Body.String())
	}
	titleIDs, _ := payload["titleIds"].([]any)
	if len(titleIDs) != 2 || titleIDs[0] != "tmdb:1" {
		t.Fatalf("titleIds order wrong: %v", titleIDs)
	}
	if _, ok := payload["cachedAt"].(string); !ok {
		t.Fatalf("cachedAt missing: %s", recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v2/catalog/sections?kind=continue-watching", nil))
	payload = decodeBody(t, recorder)
	if payload["kind"] != "household" {
		t.Fatalf("household kind wrong: %s", recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v2/catalog/sections?kind=bogus", nil))
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "unsupported_section_kind") {
		t.Fatalf("unknown kind = %d %s", recorder.Code, recorder.Body.String())
	}

	noHousehold := CatalogHandlers{Catalog: handlers.Catalog, Build: build}
	mux = http.NewServeMux()
	noHousehold.Register(mux)
	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v2/catalog/sections?kind=continue-watching", nil))
	payload = decodeBody(t, recorder)
	if ids, ok := payload["titleIds"].([]any); !ok || len(ids) != 0 {
		t.Fatalf("household section without dep must be empty: %s", recorder.Body.String())
	}
}

func TestSystemAndCatalogEndpointsUseOriginAllowlistCORS(t *testing.T) {
	allowed := []string{"null", "http://localhost:5173", "https://torwatch.lan"}
	h := CatalogHandlers{Catalog: catalog.NewService(nil, catalog.Options{}), AllowedOrigins: allowed}
	mux := http.NewServeMux()
	h.Register(mux)
	SystemHandlers{Build: buildinfo.Info{SupportedProtocolRange: []int{1, 1}}, AllowedOrigins: allowed}.Register(mux)

	cases := []struct {
		path     string
		origin   string
		wantACAO string
	}{
		{"/v1/version", "https://torwatch.lan", "https://torwatch.lan"},
		{"/v2/catalog/sections?kind=trending", "http://localhost:5173", "http://localhost:5173"},
		{"/v1/version", "null", "null"},
		{"/v1/version", "https://evil.example", ""},
		{"/v2/catalog/sections?kind=trending", "https://evil.example", ""},
		{"/v1/version", "", ""},
	}
	for _, tc := range cases {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodGet, tc.path, nil)
		if tc.origin != "" {
			request.Header.Set("Origin", tc.origin)
		}
		mux.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s origin=%q = %d, want 200", tc.path, tc.origin, recorder.Code)
		}
		if tc.path == "/v1/version" && !strings.Contains(recorder.Body.String(), "protocolVersion") {
			t.Fatalf("/v1/version body lost the version payload: %s", recorder.Body.String())
		}
		if got := recorder.Header().Get("Access-Control-Allow-Origin"); got != tc.wantACAO {
			t.Fatalf("%s origin=%q ACAO = %q, want %q", tc.path, tc.origin, got, tc.wantACAO)
		}
		if tc.wantACAO != "" && recorder.Header().Get("Vary") != "Origin" {
			t.Fatalf("%s origin=%q missing Vary: Origin", tc.path, tc.origin)
		}
	}

	// Preflight: allowed origin gets methods + negotiation headers; disallowed
	// gets no CORS headers; no Origin yields a headers-free 200.
	preflight := httptest.NewRequest(http.MethodOptions, "/v2/catalog/sections?kind=trending", nil)
	preflight.Header.Set("Origin", "https://torwatch.lan")
	preflight.Header.Set("Access-Control-Request-Method", "GET")
	preflight.Header.Set("Access-Control-Request-Headers", "X-Torwatch-Protocol")
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, preflight)
	if recorder.Code != http.StatusOK || recorder.Body.Len() != 0 {
		t.Fatalf("preflight = %d %q, want empty 200", recorder.Code, recorder.Body.String())
	}
	if recorder.Header().Get("Access-Control-Allow-Origin") != "https://torwatch.lan" ||
		!strings.Contains(recorder.Header().Get("Access-Control-Allow-Methods"), "GET") ||
		!strings.Contains(recorder.Header().Get("Access-Control-Allow-Headers"), "X-Torwatch-Protocol") {
		t.Fatalf("allowed preflight headers wrong: %v", recorder.Header())
	}

	denied := httptest.NewRequest(http.MethodOptions, "/v1/version", nil)
	denied.Header.Set("Origin", "https://evil.example")
	denied.Header.Set("Access-Control-Request-Method", "GET")
	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, denied)
	if recorder.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("disallowed preflight leaked ACAO %q", recorder.Header().Get("Access-Control-Allow-Origin"))
	}

	bare := httptest.NewRequest(http.MethodOptions, "/v1/version", nil)
	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, bare)
	if recorder.Code != http.StatusOK || recorder.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("no-Origin preflight = %d ACAO %q", recorder.Code, recorder.Header().Get("Access-Control-Allow-Origin"))
	}
}

func TestOriginAllowlistNeverAcceptsWildcard(t *testing.T) {
	allow := NewOriginAllowlist([]string{"*", " https://TorWatch.LAN ", "https://torwatch.lan", ""})
	if allow.Allows("https://anything.example") {
		t.Fatal("wildcard must not allow arbitrary origins")
	}
	if !allow.Allows("https://torwatch.lan") {
		t.Fatal("trimmed, case-insensitive allowed origin must match")
	}
}

func TestOriginNullIsHonoredOnlyWhenExplicitlyListed(t *testing.T) {
	// The default compatibility allowlist includes "null" for the packaged
	// file:// renderer; an operator-supplied list without it must block the
	// opaque origin like any other.
	mux := http.NewServeMux()
	CatalogHandlers{Catalog: catalog.NewService(nil, catalog.Options{}), AllowedOrigins: []string{"http://localhost:5173"}}.Register(mux)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/v2/catalog/sections?kind=trending", nil)
	request.Header.Set("Origin", "null")
	mux.ServeHTTP(recorder, request)
	if recorder.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("Origin null must be blocked when not explicitly allowlisted, got %q", recorder.Header().Get("Access-Control-Allow-Origin"))
	}

	allowlisted := http.NewServeMux()
	CatalogHandlers{Catalog: catalog.NewService(nil, catalog.Options{}), AllowedOrigins: []string{"null"}}.Register(allowlisted)
	recorder = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodGet, "/v2/catalog/sections?kind=trending", nil)
	request.Header.Set("Origin", "null")
	allowlisted.ServeHTTP(recorder, request)
	if recorder.Header().Get("Access-Control-Allow-Origin") != "null" {
		t.Fatalf("explicitly listed null origin must be echoed, got %q", recorder.Header().Get("Access-Control-Allow-Origin"))
	}
}
