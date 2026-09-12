package catalog

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func newStubServer(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return server
}

func TestTMDbSearchPreservesQueryCharacters(t *testing.T) {
	const query = "A B+C & 葬送/100%"
	server := newStubServer(t, func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("query"); got != query {
			t.Errorf("query = %q, want %q", got, query)
		}
		if got := r.URL.Query().Get("api_key"); got != "key+&" {
			t.Errorf("api key = %q", got)
		}
		_, _ = w.Write([]byte(`{"results":[]}`))
	})
	provider := NewTMDb(TMDbOptions{BaseURL: server.URL, APIKey: "key+&"})
	if _, err := provider.Search(context.Background(), SearchQuery{Query: query}); err != nil {
		t.Fatal(err)
	}
}

func TestTMDbSearchMappingAndAnimeClassification(t *testing.T) {
	server := newStubServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/3/search/multi" {
			http.NotFound(w, r)
			return
		}
		if r.URL.Query().Get("api_key") == "" {
			t.Fatal("tmdb api_key missing from request")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"results":[
			{"media_type":"movie","id":100,"title":"Frieren Movie","original_title":"Frieren Movie","release_date":"2026-01-15","overview":"m","poster_path":"/p.jpg","backdrop_path":"/b.jpg","original_language":"en","genre_ids":[28]},
			{"media_type":"tv","id":209867,"name":"Frieren","original_name":"葬送のフリーレン","first_air_date":"2023-09-29","overview":"tv","poster_path":"/tv.jpg","original_language":"ja","genre_ids":[16,10759]},
			{"media_type":"tv","id":300,"name":"Live Action","first_air_date":"2020-01-01","original_language":"en","genre_ids":[16]},
			{"media_type":"person","id":1,"name":"Someone"}
		]}`))
	})
	provider := NewTMDb(TMDbOptions{BaseURL: server.URL, APIKey: "test-key"})

	titles, err := provider.Search(context.Background(), SearchQuery{Query: "frieren"})
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(titles) != 3 {
		t.Fatalf("person results must be dropped: %d titles", len(titles))
	}
	movie := titles[0]
	if movie.ID != "tmdb:movie:100" || movie.Type != TypeMovie || movie.Year != 2026 {
		t.Fatalf("movie mapping wrong: %+v", movie)
	}
	if movie.ProviderIDs["tmdb"] != "movie:100" {
		t.Fatalf("qualified tmdb provider id wrong: %+v", movie.ProviderIDs)
	}
	if movie.Artwork["poster"] != "https://image.tmdb.org/t/p/w342/p.jpg" {
		t.Fatalf("poster url wrong: %v", movie.Artwork)
	}
	anime := titles[1]
	if anime.Type != TypeAnime || anime.OriginalTitle != "葬送のフリーレン" || anime.Year != 2023 {
		t.Fatalf("anime classification wrong: %+v", anime)
	}
	series := titles[2]
	if series.Type != TypeSeries {
		t.Fatalf("ja+16 required for anime; got %q", series.Type)
	}
}

func TestTMDbDetailFallsBackMovieThenTV(t *testing.T) {
	requested := []string{}
	server := newStubServer(t, func(w http.ResponseWriter, r *http.Request) {
		requested = append(requested, r.URL.Path)
		switch r.URL.Path {
		case "/3/movie/209867":
			http.NotFound(w, r)
		case "/3/tv/209867":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":209867,"name":"Frieren","original_name":"葬送のフリーレン","first_air_date":"2023-09-29","overview":"tv","poster_path":"/tv.jpg","episode_run_time":[24],"genres":[{"name":"Animation"}],"homepage":"https://example.com/frieren"}`))
		default:
			http.NotFound(w, r)
		}
	})
	provider := NewTMDb(TMDbOptions{BaseURL: server.URL, APIKey: "test-key"})

	title, err := provider.Detail(context.Background(), DetailRequest{ProviderIDs: map[string]string{"tmdb": "209867"}})
	if err != nil {
		t.Fatalf("detail: %v", err)
	}
	if title.Type != TypeSeries || title.Runtime != 24 || len(title.Genres) != 1 {
		t.Fatalf("tv detail mapping wrong: %+v", title)
	}
	// M3.1.1: the legacy alias resolves through the movie→tv probe but the
	// emitted canonical id is the media-qualified truth.
	if title.ID != "tmdb:tv:209867" || title.ProviderIDs["tmdb"] != "tv:209867" {
		t.Fatalf("alias detail must emit the qualified id: %+v", title)
	}
	if title.ExternalLinks["homepage"] != "https://example.com/frieren" {
		t.Fatalf("external links wrong: %v", title.ExternalLinks)
	}
	if len(requested) != 2 || requested[0] != "/3/movie/209867" || requested[1] != "/3/tv/209867" {
		t.Fatalf("deterministic probe order wrong: %v", requested)
	}

	requested = nil
	_, err = provider.Detail(context.Background(), DetailRequest{ProviderIDs: map[string]string{"tmdb": "999999"}})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing title = %v, want ErrNotFound", err)
	}
}

func TestTMDbEpisodesMapping(t *testing.T) {
	server := newStubServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"season_number":1,"episodes":[
			{"episode_number":1,"season_number":1,"name":"The Journey's End","air_date":"2023-09-29","still_path":"/e1.jpg","overview":"start","runtime":24},
			{"episode_number":2,"season_number":1,"name":"It Would Be Embarrassing","air_date":"2023-10-06","runtime":24}
		]}`))
	})
	provider := NewTMDb(TMDbOptions{BaseURL: server.URL, APIKey: "test-key"})

	episodes, err := provider.Episodes(context.Background(), EpisodeRequest{ProviderIDs: map[string]string{"tmdb": "209867"}, Season: 1})
	if err != nil {
		t.Fatalf("episodes: %v", err)
	}
	if len(episodes) != 2 || episodes[0].ID != "tmdb:209867:1:1" || episodes[0].DurationS != 1440 {
		t.Fatalf("episode mapping wrong: %+v", episodes)
	}
	if episodes[0].Still != "https://image.tmdb.org/t/p/w300/e1.jpg" {
		t.Fatalf("still url wrong: %q", episodes[0].Still)
	}
}

func TestTMDbRateLimitAndMissingKey(t *testing.T) {
	server := newStubServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
	})
	provider := NewTMDb(TMDbOptions{BaseURL: server.URL, APIKey: "test-key"})
	if _, err := provider.Search(context.Background(), SearchQuery{Query: "x"}); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("429 = %v, want ErrRateLimited", err)
	}

	noKey := NewTMDb(TMDbOptions{BaseURL: server.URL})
	if _, err := noKey.Search(context.Background(), SearchQuery{Query: "x"}); !errors.Is(err, errProviderUnavailable) {
		t.Fatalf("missing key = %v, want errProviderUnavailable", err)
	}
}

func TestTMDbDetailMapsSeasonsForTVOnly(t *testing.T) {
	server := newStubServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/3/tv/209867":
			_, _ = w.Write([]byte(`{"id":209867,"name":"Frieren","first_air_date":"2023-09-29","seasons":[
				{"season_number":0,"name":"Specials","episode_count":3,"air_date":"2023-09-01"},
				{"season_number":1,"name":"Season 1","episode_count":28,"air_date":"2023-09-29","poster_path":"/s1.jpg"},
				{"season_number":2,"name":"Season 2","episode_count":0}
			]}`))
		case "/3/tv/300":
			_, _ = w.Write([]byte(`{"id":300,"name":"No Seasons"}`))
		default:
			http.NotFound(w, r)
		}
	})
	provider := NewTMDb(TMDbOptions{BaseURL: server.URL, APIKey: "test-key"})

	title, err := provider.Detail(context.Background(), DetailRequest{ProviderIDs: map[string]string{"tmdb": "209867"}})
	if err != nil {
		t.Fatal(err)
	}
	// Same seasons the renderer consumed from the TMDb raw payload: numbered
	// seasons with an episode count (specials included), empty seasons
	// dropped, sorted by number.
	if len(title.Seasons) != 2 {
		t.Fatalf("seasons = %+v, want specials + season 1", title.Seasons)
	}
	if title.Seasons[0].Number != 0 || title.Seasons[0].EpisodeCount != 3 {
		t.Fatalf("specials mapping wrong: %+v", title.Seasons[0])
	}
	season := title.Seasons[1]
	if season.Number != 1 || season.Name != "Season 1" || season.EpisodeCount != 28 || season.AirDate != "2023-09-29" {
		t.Fatalf("season mapping wrong: %+v", season)
	}
	if season.Poster != "https://image.tmdb.org/t/p/w342/s1.jpg" {
		t.Fatalf("season poster wrong: %q", season.Poster)
	}

	plain, err := provider.Detail(context.Background(), DetailRequest{ProviderIDs: map[string]string{"tmdb": "300"}})
	if err != nil {
		t.Fatal(err)
	}
	if plain.Seasons != nil {
		t.Fatalf("tv without seasons must not fabricate any: %+v", plain.Seasons)
	}
}

func TestTMDbSectionPagePassesPageAndTotalPages(t *testing.T) {
	server := newStubServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/3/trending/all/week" {
			http.NotFound(w, r)
			return
		}
		if got := r.URL.Query().Get("page"); got != "2" {
			t.Fatalf("page = %q, want 2", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"page":2,"total_pages":7,"results":[
			{"media_type":"movie","id":100,"title":"Second Page Movie","release_date":"2026-01-15"}
		]}`))
	})
	provider := NewTMDb(TMDbOptions{BaseURL: server.URL, APIKey: "test-key"})

	titles, totalPages, err := provider.SectionPage(context.Background(), "popular", 2)
	if err != nil {
		t.Fatal(err)
	}
	if totalPages != 7 || len(titles) != 1 || titles[0].ID != "tmdb:movie:100" {
		t.Fatalf("paged section = %d pages, %+v", totalPages, titles)
	}

	if _, _, err := provider.SectionPage(context.Background(), "bogus", 1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown kind = %v, want ErrNotFound", err)
	}
}

func TestTMDbGenreSectionDiscoverQueries(t *testing.T) {
	server := newStubServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/3/discover/movie":
			if got := r.URL.Query().Get("with_genres"); got != "28" {
				t.Fatalf("with_genres = %q, want 28", got)
			}
			if got := r.URL.Query().Get("page"); got != "3" {
				t.Fatalf("page = %q, want 3", got)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"page":3,"total_pages":42,"results":[
				{"media_type":"movie","id":500,"title":"Action Movie","release_date":"2026-02-01"}
			]}`))
		default:
			http.NotFound(w, r)
		}
	})
	provider := NewTMDb(TMDbOptions{BaseURL: server.URL, APIKey: "test-key"})

	titles, totalPages, err := provider.GenreSection(context.Background(), TypeMovie, 28, 3)
	if err != nil {
		t.Fatal(err)
	}
	if totalPages != 42 || len(titles) != 1 || titles[0].ID != "tmdb:movie:500" || titles[0].Type != TypeMovie {
		t.Fatalf("genre section = %d pages, %+v", totalPages, titles)
	}

	if _, _, err := provider.GenreSection(context.Background(), TypeAnime, 28, 1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("anime genre section = %v, want ErrNotFound (tmdb discovers movie/tv only)", err)
	}
}

func TestTMDbPopularCandidatesMapGenresAndKeepQualifiedIds(t *testing.T) {
	server := newStubServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/3/genre/movie/list":
			_, _ = w.Write([]byte(`{"genres":[{"id":28,"name":"Action"},{"id":12,"name":"Adventure"}]}`))
		case "/3/genre/tv/list":
			_, _ = w.Write([]byte(`{"genres":[{"id":16,"name":"Animation"},{"id":10759,"name":"Action & Adventure"}]}`))
		case "/3/trending/all/week":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"page":1,"total_pages":1,"results":[
				{"media_type":"movie","id":500,"title":"Action Movie","release_date":"2026-01-01","genre_ids":[28]},
				{"media_type":"movie","id":500,"title":"Duplicate","release_date":"2026-01-01","genre_ids":[28]},
				{"media_type":"tv","id":555,"name":"Animated Series","first_air_date":"2023-01-01","original_language":"ja","genre_ids":[16]}
			]}`))
		default:
			http.NotFound(w, r)
		}
	})
	provider := NewTMDb(TMDbOptions{BaseURL: server.URL, APIKey: "test-key"})

	candidates, err := provider.PopularCandidates(context.Background(), 200)
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 2 {
		t.Fatalf("candidates = %d, duplicates must deduplicate", len(candidates))
	}
	// Rank = pool position (provider popularity order).
	if candidates[0].ID != "tmdb:movie:500" || candidates[0].ProviderIDs["tmdb"] != "movie:500" {
		t.Fatalf("first candidate wrong: %+v", candidates[0])
	}
	if len(candidates[0].Genres) != 1 || candidates[0].Genres[0] != "Action" {
		t.Fatalf("genre mapping wrong: %+v", candidates[0].Genres)
	}
	if candidates[1].Type != TypeAnime {
		t.Fatalf("anime classification must survive candidate mapping: %+v", candidates[1])
	}
	if len(candidates[1].Genres) != 1 || candidates[1].Genres[0] != "Animation" {
		t.Fatalf("tv genre mapping wrong: %+v", candidates[1].Genres)
	}
}

// Regression (repair pass): a movie and a TV show sharing the same numeric id
// are TWO different candidates — deduplication must use the qualified media
// identity, never the numeric id alone.
func TestTMDbPopularCandidatesKeepSameNumberMovieAndTV(t *testing.T) {
	server := newStubServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/3/genre/movie/list":
			_, _ = w.Write([]byte(`{"genres":[]}`))
		case "/3/genre/tv/list":
			_, _ = w.Write([]byte(`{"genres":[]}`))
		case "/3/trending/all/week":
			_, _ = w.Write([]byte(`{"page":1,"total_pages":1,"results":[
				{"media_type":"movie","id":123,"title":"Collision Movie","release_date":"2020-01-01","genre_ids":[]},
				{"media_type":"tv","id":123,"name":"Collision Series","first_air_date":"2021-01-01","genre_ids":[]}
			]}`))
		default:
			http.NotFound(w, r)
		}
	})
	provider := NewTMDb(TMDbOptions{BaseURL: server.URL, APIKey: "test-key"})

	candidates, err := provider.PopularCandidates(context.Background(), 200)
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 2 {
		t.Fatalf("same-number movie/TV collapsed to %d candidates", len(candidates))
	}
	if candidates[0].ID != "tmdb:movie:123" || candidates[1].ID != "tmdb:tv:123" {
		t.Fatalf("qualified ids wrong: %+v", candidates)
	}
	if candidates[0].Type != TypeMovie || candidates[1].Type != TypeSeries {
		t.Fatalf("media kinds wrong: %+v", candidates)
	}
}

func TestTMDbQualifiedDetailProbesOnlyRequestedMediaType(t *testing.T) {
	requested := []string{}
	server := newStubServer(t, func(w http.ResponseWriter, r *http.Request) {
		requested = append(requested, r.URL.Path)
		switch r.URL.Path {
		case "/3/movie/123":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":123,"title":"Collision Movie","release_date":"2020-01-01","overview":"the movie"}`))
		case "/3/tv/123":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":123,"name":"Collision Series","first_air_date":"2021-01-01","overview":"the series","episode_run_time":[42]}`))
		default:
			http.NotFound(w, r)
		}
	})
	provider := NewTMDb(TMDbOptions{BaseURL: server.URL, APIKey: "test-key"})

	// M3.1.1: the qualified tv id resolves the SERIES directly even though
	// the same numeric id exists as a movie — exactly one endpoint is hit.
	title, err := provider.Detail(context.Background(), DetailRequest{ProviderIDs: map[string]string{"tmdb": "tv:123"}})
	if err != nil {
		t.Fatal(err)
	}
	if title.ID != "tmdb:tv:123" || title.Type != TypeSeries || title.Title != "Collision Series" {
		t.Fatalf("qualified tv detail wrong: %+v", title)
	}
	if len(requested) != 1 || requested[0] != "/3/tv/123" {
		t.Fatalf("qualified tv detail must probe only the tv endpoint: %v", requested)
	}

	requested = nil
	movie, err := provider.Detail(context.Background(), DetailRequest{ProviderIDs: map[string]string{"tmdb": "movie:123"}})
	if err != nil {
		t.Fatal(err)
	}
	if movie.ID != "tmdb:movie:123" || movie.Type != TypeMovie || movie.Title != "Collision Movie" {
		t.Fatalf("qualified movie detail wrong: %+v", movie)
	}
	if len(requested) != 1 || requested[0] != "/3/movie/123" {
		t.Fatalf("qualified movie detail must probe only the movie endpoint: %v", requested)
	}
}

func TestTMDbQualifiedDetailNeverFallsBackAcrossMediaTypes(t *testing.T) {
	requested := []string{}
	server := newStubServer(t, func(w http.ResponseWriter, r *http.Request) {
		requested = append(requested, r.URL.Path)
		if r.URL.Path == "/3/movie/999" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":999,"title":"Only A Movie","release_date":"2020-01-01"}`))
			return
		}
		http.NotFound(w, r)
	})
	provider := NewTMDb(TMDbOptions{BaseURL: server.URL, APIKey: "test-key"})

	// The tv endpoint 404s; the movie with the same numeric id exists but a
	// qualified tv request must NEVER fall back to it (M3.1.1).
	_, err := provider.Detail(context.Background(), DetailRequest{ProviderIDs: map[string]string{"tmdb": "tv:999"}})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("qualified tv detail = %v, want ErrNotFound", err)
	}
	if len(requested) != 1 || requested[0] != "/3/tv/999" {
		t.Fatalf("qualified tv detail must not probe the movie endpoint: %v", requested)
	}
}

func TestTMDbQualifiedEpisodeIdsEmbedTheQualifiedTitleId(t *testing.T) {
	requested := []string{}
	server := newStubServer(t, func(w http.ResponseWriter, r *http.Request) {
		requested = append(requested, r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"season_number":1,"episodes":[{"episode_number":1,"season_number":1,"name":"Ep1"}]}`))
	})
	provider := NewTMDb(TMDbOptions{BaseURL: server.URL, APIKey: "test-key"})

	episodes, err := provider.Episodes(context.Background(), EpisodeRequest{ProviderIDs: map[string]string{"tmdb": "tv:209867"}, Season: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(episodes) != 1 || episodes[0].ID != "tmdb:tv:209867:1:1" {
		t.Fatalf("episode ids must embed the qualified title id: %+v", episodes)
	}
	if episodes[0].ProviderIDs["tmdb"] != "tv:209867" {
		t.Fatalf("episode provider ids must stay qualified: %+v", episodes[0].ProviderIDs)
	}
	if len(requested) != 1 || requested[0] != "/3/tv/209867/season/1" {
		t.Fatalf("episodes must resolve through the numeric tv endpoint: %v", requested)
	}
}
