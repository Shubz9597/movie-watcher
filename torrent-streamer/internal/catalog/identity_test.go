package catalog

import (
	"context"
	"net/http"
	"testing"
)

// M3.1 canonical identity investigation (specs/002-mobile-shared-ui/
// evidence/m3.1-identity-contracts.md): characterize the ACTUAL behavior of
// the opaque `tmdb:<numeric>` id when the same numeric id exists in BOTH
// TMDb namespaces (movie and tv ids are independent sequences upstream, so
// numeric collisions are real, not hypothetical).

func TestIdentitySameNumericIdInBothTMDbNamespaces(t *testing.T) {
	server := newStubServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/3/movie/123":
			// A MOVIE with numeric id 123 exists.
			_, _ = w.Write([]byte(`{"id":123,"title":"Collision Movie","release_date":"2020-01-01","overview":"the movie"}`))
		case "/3/tv/123":
			// A SERIES with the SAME numeric id 123 also exists.
			_, _ = w.Write([]byte(`{"id":123,"name":"Collision Series","first_air_date":"2021-01-01","overview":"the series","episode_run_time":[42]}`))
		default:
			http.NotFound(w, r)
		}
	})
	provider := NewTMDb(TMDbOptions{BaseURL: server.URL, APIKey: "test-key"})

	title, err := provider.Detail(context.Background(), DetailRequest{ProviderIDs: map[string]string{"tmdb": "123"}})
	if err != nil {
		t.Fatal(err)
	}
	// DOCUMENTED FINDING: the unqualified id probes the movie endpoint
	// FIRST and returns the movie — the series with the same numeric id is
	// UNREACHABLE through `tmdb:123`. Identity is ambiguous without a
	// media qualifier.
	if title.Type != TypeMovie || title.Title != "Collision Movie" {
		t.Fatalf("unqualified tmdb:123 resolved to %+v; documented probe order must pick the movie", title)
	}
	if title.ID != "tmdb:123" {
		t.Fatalf("emitted id = %q, want the same unqualified form (current behavior)", title.ID)
	}
}

func TestIdentityEpisodesUseUnqualifiedIdNamespace(t *testing.T) {
	server := newStubServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/3/tv/123/season/1":
			_, _ = w.Write([]byte(`{"season_number":1,"episodes":[{"episode_number":1,"season_number":1,"name":"Ep1"}]}`))
		default:
			http.NotFound(w, r)
		}
	})
	provider := NewTMDb(TMDbOptions{BaseURL: server.URL, APIKey: "test-key"})

	episodes, err := provider.Episodes(context.Background(), EpisodeRequest{ProviderIDs: map[string]string{"tmdb": "123"}, Season: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(episodes) != 1 || episodes[0].ID != "tmdb:123:1:1" {
		t.Fatalf("episode ids carry the UNQUALIFIED title id: %+v", episodes)
	}
}

func TestIdentityMergeDoesNotCrossMediaTypes(t *testing.T) {
	// The same normalized title + year for a movie and a series must stay
	// separate entries (merge key = normalized title + year + type).
	movie := Title{ID: "tmdb:100", Type: TypeMovie, Title: "Same Name", Year: 2020, ProviderIDs: map[string]string{"tmdb": "100"}, MergedFrom: []string{"tmdb"}}
	series := Title{ID: "tmdb:200", Type: TypeSeries, Title: "Same Name", Year: 2020, ProviderIDs: map[string]string{"tmdb": "200"}, MergedFrom: []string{"tmdb"}}
	merged := MergeTitles([][]Title{{movie, series}})
	if len(merged) != 2 {
		t.Fatalf("merge produced %d entries, want 2 (movie/series must not merge)", len(merged))
	}
	if merged[0].ID != "tmdb:100" || merged[1].ID != "tmdb:200" {
		t.Fatalf("deterministic ordering broken: %+v", merged)
	}
}

func TestIdentityAnimeClassificationKeepsTMDbNamespace(t *testing.T) {
	// A TMDb tv title classified as anime (original_language ja + genre 16)
	// still uses the `tmdb:` namespace and the series structure — anime is a
	// CLASSIFICATION over movie/series structure, not a third id namespace.
	server := newStubServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/3/search/multi":
			_, _ = w.Write([]byte(`{"results":[{"media_type":"tv","id":555,"name":"Japanese Animated Series","first_air_date":"2023-01-01","original_language":"ja","genre_ids":[16]}]}`))
		case "/3/tv/555":
			_, _ = w.Write([]byte(`{"id":555,"name":"Japanese Animated Series","first_air_date":"2023-01-01","original_language":"ja","genre_ids":[16]}`))
		default:
			http.NotFound(w, r)
		}
	})
	provider := NewTMDb(TMDbOptions{BaseURL: server.URL, APIKey: "test-key"})
	results, err := provider.Search(context.Background(), SearchQuery{Query: "Japanese Animated"})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 {
		t.Fatalf("results = %d", len(results))
	}
	if results[0].Type != TypeAnime || results[0].ID != "tmdb:555" {
		t.Fatalf("anime classification = %q id %q; must stay in the tmdb namespace", results[0].Type, results[0].ID)
	}
}
