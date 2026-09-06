package catalog

import (
	"context"
	"errors"
	"net/http"
	"testing"
)

func TestJikanSearchAndDetail(t *testing.T) {
	server := newStubServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/v4/anime":
			_, _ = w.Write([]byte(`{"data":[
				{"mal_id":52991,"title":"Sousou no Frieren","title_english":"Frieren: Beyond Journey's End","title_japanese":"葬送のフリーレン","synopsis":"syn","aired":{"from":"2023-09-29"},"images":{"jpg":{"large_image_url":"large.jpg"}},"genres":[{"name":"Adventure"}],"duration":"24 min per ep"},
				{"mal_id":1,"title":"No English","title_japanese":"日本語","aired":{"from":"1999-01-01"},"images":{"jpg":{"image_url":"small.jpg"}},"genres":[],"duration":"2 hr per ep"}
			]}`))
		case r.URL.Path == "/v4/anime/52991":
			_, _ = w.Write([]byte(`{"data":{"mal_id":52991,"title":"Sousou no Frieren","title_english":"Frieren","aired":{"from":"2023-09-29"},"images":{"jpg":{"large_image_url":"large.jpg"}},"genres":[],"duration":"24 min per ep"}}`))
		default:
			http.NotFound(w, r)
		}
	})
	provider := NewJikan(JikanOptions{BaseURL: server.URL})

	titles, err := provider.Search(context.Background(), SearchQuery{Query: "frieren"})
	if err != nil || len(titles) != 2 {
		t.Fatalf("search = %v, %v", titles, err)
	}
	first := titles[0]
	if first.ID != "jikan:52991" || first.Type != TypeAnime || first.Title != "Frieren: Beyond Journey's End" {
		t.Fatalf("mapping wrong: %+v", first)
	}
	if first.Year != 2023 || first.Runtime != 24 || first.Artwork["poster"] != "large.jpg" {
		t.Fatalf("fields wrong: %+v", first)
	}
	if titles[1].Runtime != 120 || titles[1].Title != "No English" {
		t.Fatalf("fallback title/duration wrong: %+v", titles[1])
	}

	detail, err := provider.Detail(context.Background(), DetailRequest{ProviderIDs: map[string]string{"jikan": "52991"}})
	if err != nil || detail.ID != "jikan:52991" {
		t.Fatalf("detail = %+v, %v", detail, err)
	}
	if _, err := provider.Detail(context.Background(), DetailRequest{ProviderIDs: map[string]string{"tmdb": "1"}}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown namespace = %v", err)
	}
}

func TestJikanEpisodes(t *testing.T) {
	server := newStubServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[
			{"mal_id":1,"title":"The Journey's End","aired":"2023-09-29T00:00:00Z"},
			{"mal_id":2,"title":"It Would Be Embarrassing","aired":"2023-10-06T00:00:00Z"}
		]}`))
	})
	provider := NewJikan(JikanOptions{BaseURL: server.URL})
	episodes, err := provider.Episodes(context.Background(), EpisodeRequest{ProviderIDs: map[string]string{"jikan": "52991"}, Season: 1})
	if err != nil || len(episodes) != 2 {
		t.Fatalf("episodes = %v, %v", episodes, err)
	}
	if episodes[0].ID != "jikan:52991:1:1" || episodes[0].Episode != 1 || episodes[1].Episode != 2 {
		t.Fatalf("episode numbering wrong: %+v", episodes)
	}
}

func TestJikanRateLimit(t *testing.T) {
	server := newStubServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
	})
	provider := NewJikan(JikanOptions{BaseURL: server.URL})
	if _, err := provider.Search(context.Background(), SearchQuery{Query: "x"}); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("429 = %v", err)
	}
}
