package catalog

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestTitleForIMDb(t *testing.T) {
	cinemetaCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cinemetaCalls++
		switch r.URL.Path {
		case "/meta/series/tt0944947.json":
			_, _ = w.Write([]byte(`{"meta":{"id":"tt0944947","imdb_id":"tt0944947","type":"series","name":"Game of Thrones","moviedb_id":1399,"releaseInfo":"2011-2019"}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	links := &MemoryIDLinks{}
	service := NewService([]Provider{NewCinemeta(CinemetaOptions{BaseURL: server.URL})}, Options{Links: links})
	ctx := context.Background()

	if got := service.TitleForIMDb(ctx, "tt0944947", "series"); got != "tmdb:tv:1399" {
		t.Fatalf("Game of Thrones = %q, want tmdb:tv:1399 (Cinemeta's TMDb id)", got)
	}
	if link, ok := links.GetLink(ctx, "tmdb:tv:1399"); !ok || link.ProviderIDs["imdb"] != "tt0944947" {
		t.Fatalf("link not remembered: %+v", link)
	}
	// A title already known (an anime) keeps its type; it gains the IMDb id.
	links.PutLink(ctx, "tmdb:tv:37854", IDLink{ProviderIDs: map[string]string{"tmdb": "tv:37854"}, Type: TypeAnime, Title: "One Piece"})
	server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/meta/series/tt0388629.json" {
			_, _ = w.Write([]byte(`{"meta":{"id":"tt0388629","type":"series","name":"One Piece","moviedb_id":37854}}`))
			return
		}
		http.NotFound(w, r)
	})
	if got := service.TitleForIMDb(ctx, "tt0388629", "series"); got != "tmdb:tv:37854" {
		t.Fatalf("One Piece = %q", got)
	}
	if link, _ := links.GetLink(ctx, "tmdb:tv:37854"); link.Type != TypeAnime || link.ProviderIDs["imdb"] != "tt0388629" {
		t.Fatalf("known link changed: %+v", link)
	}
	if got := service.TitleForIMDb(ctx, "tt0000001", "movie"); got != "imdb:tt0000001" {
		t.Fatalf("unknown to Cinemeta = %q, want the IMDb id", got)
	}
	if got := service.TitleForIMDb(ctx, "kitsu:12", "series"); got != "" {
		t.Fatalf("not an IMDb id = %q", got)
	}
}
