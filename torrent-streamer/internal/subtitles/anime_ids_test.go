package subtitles

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAnimeEpisodeIMDbUsesPerEpisodeSeasons(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.RawQuery {
		case "anilist_id=142329":
			_, _ = w.Write([]byte(`{"mappings":{"imdb_id":"tt9335498"},"episodes":{"1":{"seasonNumber":3,"episodeNumber":1},"5":{"seasonNumber":3,"episodeNumber":5},"S1":{"seasonNumber":0,"episodeNumber":1}}}`))
		case "mal_id=52991":
			_, _ = w.Write([]byte(`{"mappings":{"imdb_id":"tt22248376"},"episodes":{}}`))
		default:
			_, _ = w.Write([]byte(`{"mappings":{},"episodes":{}}`))
		}
	}))
	defer server.Close()
	t.Setenv("TORWATCH_ANIZIP_BASE_URL", server.URL)

	if imdb, season, episode, ok := AnimeEpisodeIMDb(context.Background(), 142329, 0, 5); !ok || imdb != "tt9335498" || season != 3 || episode != 5 {
		t.Fatalf("arc episode = %s S%dE%d %t, want tt9335498 S3E5", imdb, season, episode, ok)
	}
	if imdb, season, episode, ok := AnimeEpisodeIMDb(context.Background(), 0, 52991, 4); !ok || imdb != "tt22248376" || season != 1 || episode != 4 {
		t.Fatalf("MAL fallback = %s S%dE%d %t, want entry numbering", imdb, season, episode, ok)
	}
	if _, _, _, ok := AnimeEpisodeIMDb(context.Background(), 777, 0, 1); ok {
		t.Fatal("a title without an IMDb mapping must report ok=false")
	}
}
