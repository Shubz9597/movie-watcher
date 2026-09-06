package catalog

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
)

func TestCinemetaDetailFallsBackSeriesThenMovie(t *testing.T) {
	requested := []string{}
	server := newStubServer(t, func(w http.ResponseWriter, r *http.Request) {
		requested = append(requested, r.URL.Path)
		if strings.Contains(r.URL.Path, "tt28015436") {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"meta":{"id":"tt28015436","imdb_id":"tt28015436","name":"Frieren","type":"series","releaseInfo":"2023–2026","poster":"https://poster.png","background":{"url":"https://bg.png"},"description":"desc","runtime":"24 min","genre":["Animation","Adventure"],"videos":[
				{"id":"tt28015436:1:1","season":1,"episode":1,"name":"The Journey's End","released":"2023-09-29","thumbnail":"https://e1.png"},
				{"id":"tt28015436:1:2","season":1,"episode":2,"name":"Two","released":"2023-10-06"},
				{"id":"tt28015436:special","season":"","episode":"","name":"Special"}
			]}}`))
			return
		}
		http.NotFound(w, r)
	})
	provider := NewCinemeta(CinemetaOptions{BaseURL: server.URL})

	title, err := provider.Detail(context.Background(), DetailRequest{ProviderIDs: map[string]string{"imdb": "tt28015436"}})
	if err != nil {
		t.Fatalf("detail: %v", err)
	}
	if title.ID != "imdb:tt28015436" || title.Type != TypeSeries || title.IMDBID != "tt28015436" {
		t.Fatalf("mapping wrong: %+v", title)
	}
	if title.Year != 2023 || title.Runtime != 24 {
		t.Fatalf("releaseInfo/runtime parsing wrong: %+v", title)
	}
	if title.Artwork["poster"] != "https://poster.png" || title.Artwork["background"] != "https://bg.png" {
		t.Fatalf("poster/background object-or-string forms wrong: %v", title.Artwork)
	}
	if len(requested) != 1 || !strings.Contains(requested[0], "/meta/series/") {
		t.Fatalf("series must be probed first: %v", requested)
	}

	episodes, err := provider.Episodes(context.Background(), EpisodeRequest{ProviderIDs: map[string]string{"imdb": "tt28015436"}, Season: 1})
	if err != nil {
		t.Fatalf("episodes: %v", err)
	}
	if len(episodes) != 2 {
		t.Fatalf("non-numeric season/episode rows must be dropped: %d", len(episodes))
	}
	if episodes[0].ID != "imdb:tt28015436:1:1" || episodes[0].Still != "https://e1.png" {
		t.Fatalf("episode mapping wrong: %+v", episodes[0])
	}
}

func TestCinemetaMovieFallback(t *testing.T) {
	requested := []string{}
	server := newStubServer(t, func(w http.ResponseWriter, r *http.Request) {
		requested = append(requested, r.URL.Path)
		if strings.Contains(r.URL.Path, "/meta/movie/") {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"meta":{"id":"tt0000001","name":"Old Movie","type":"movie","releaseInfo":"1921","poster":"p.png"}}`))
			return
		}
		http.NotFound(w, r)
	})
	provider := NewCinemeta(CinemetaOptions{BaseURL: server.URL})

	title, err := provider.Detail(context.Background(), DetailRequest{ProviderIDs: map[string]string{"imdb": "tt0000001"}})
	if err != nil || title.Type != TypeMovie || title.Year != 1921 {
		t.Fatalf("movie fallback = %+v, %v", title, err)
	}
	if len(requested) != 2 || !strings.Contains(requested[1], "/meta/movie/") {
		t.Fatalf("series must be probed before movie: %v", requested)
	}
}

func TestCinemetaUnknownTitle(t *testing.T) {
	server := newStubServer(t, func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	})
	provider := NewCinemeta(CinemetaOptions{BaseURL: server.URL})
	if _, err := provider.Detail(context.Background(), DetailRequest{ProviderIDs: map[string]string{"imdb": "tt9999999"}}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown = %v", err)
	}
}
