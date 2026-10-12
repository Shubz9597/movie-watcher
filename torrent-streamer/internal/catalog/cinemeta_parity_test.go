package catalog

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

// A title answered by Cinemeta alone must carry what the app reads from
// TMDb: the TMDb id and the season list (here Death Note, recorded live:
// 37 episodes in season 1 from 2006-10-04, TMDb tv:13916).
func TestCinemetaTitleCarriesTMDbIDAndSeasons(t *testing.T) {
	fixture, err := os.ReadFile("testdata/cinemeta_death_note.json")
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/meta/series/tt0877057.json" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(fixture)
	}))
	defer server.Close()
	provider := NewCinemeta(CinemetaOptions{BaseURL: server.URL, HTTP: server.Client()})
	title, err := provider.Detail(context.Background(), DetailRequest{ProviderIDs: map[string]string{"imdb": "tt0877057"}})
	if err != nil {
		t.Fatal(err)
	}
	if title.ProviderIDs["tmdb"] != "tv:13916" || title.ProviderIDs["imdb"] != "tt0877057" {
		t.Fatalf("provider ids = %v", title.ProviderIDs)
	}
	if len(title.Seasons) != 1 || title.Seasons[0] != (Season{Number: 1, Name: "Season 1", EpisodeCount: 37, AirDate: "2006-10-04"}) {
		t.Fatalf("seasons = %+v", title.Seasons)
	}
}

// With TMDb search failing, search still finds the title — as the TMDb title
// the app opens (tmdb:tv:13916) — and its page then resolves through the
// remembered link while TMDb stays down.
func TestSearchFallsBackToCinemetaAsTMDbTitles(t *testing.T) {
	fixture, err := os.ReadFile("testdata/cinemeta_death_note.json")
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/catalog/series/top/search=death note.json":
			_, _ = w.Write([]byte(`{"metas":[{"id":"tt0877057","imdb_id":"tt0877057","type":"series","name":"Death Note"}]}`))
		case "/catalog/movie/top/search=death note.json":
			_, _ = w.Write([]byte(`{"metas":[]}`))
		case "/meta/series/tt0877057.json":
			_, _ = w.Write(fixture)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	tmdb := &fakeProvider{name: "tmdb",
		searchFn: func(context.Context, SearchQuery) ([]Title, error) {
			return nil, errors.New("provider request failed: connection reset by peer")
		},
		detailFn: func(context.Context, DetailRequest) (Title, error) {
			return Title{}, errors.New("provider request failed: connection reset by peer")
		},
	}
	links := &MemoryIDLinks{}
	service := NewService([]Provider{tmdb, NewCinemeta(CinemetaOptions{BaseURL: server.URL, HTTP: server.Client()})}, Options{Links: links})
	defer service.Close()

	result := service.Search(context.Background(), SearchQuery{Query: "death note"})
	if len(result.Titles) != 1 || result.Titles[0].ID != "tmdb:tv:13916" || result.Titles[0].Title != "Death Note" {
		t.Fatalf("search = %+v", result.Titles)
	}
	detail := service.Detail(context.Background(), "tmdb:tv:13916")
	if !detail.Found || detail.Title.ID != "tmdb:tv:13916" || len(detail.Title.Seasons) != 1 {
		t.Fatalf("the found title's page must open while TMDb is down: %+v", detail)
	}
}
