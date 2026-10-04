package catalog

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

func TestSearchProvidersStartConcurrentlyAndPreservePriority(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		release := make(chan struct{})
		var started atomic.Int32
		providers := make([]Provider, 4)
		for i := range providers {
			index := i
			providers[i] = &fakeProvider{name: string(rune('a' + i)), searchFn: func(ctx context.Context, _ SearchQuery) ([]Title, error) {
				started.Add(1)
				select {
				case <-release:
				case <-ctx.Done():
					return nil, ctx.Err()
				}
				return []Title{{ID: string(rune('a'+index)) + ":1", Title: "Same", Year: 2020, Type: TypeMovie, Overview: string(rune('a' + index))}}, nil
			}}
		}
		s := NewService(providers, Options{})
		defer s.Close()
		done := make(chan SearchResult, 1)
		go func() { done <- s.Search(t.Context(), SearchQuery{Query: "Same"}) }()
		synctest.Wait()
		if got := started.Load(); got != 4 {
			t.Errorf("Search starts = %d, want all 4 before releasing responses", got)
		}
		close(release)
		result := <-done
		if len(result.Titles) != 1 || result.Titles[0].Overview != "a" {
			t.Errorf("Search merge = %+v, want highest priority a", result)
		}
	})
}

func TestSharedMissSurvivesCanceledCaller(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		release := make(chan struct{})
		var calls atomic.Int32
		p := &fakeProvider{name: "up", searchFn: func(ctx context.Context, _ SearchQuery) ([]Title, error) {
			calls.Add(1)
			select {
			case <-release:
				return []Title{{ID: "up:1", Title: "Title"}}, nil
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}}
		s := NewService([]Provider{p}, Options{})
		defer s.Close()
		ctx, cancel := context.WithCancel(t.Context())
		var workers sync.WaitGroup
		workers.Go(func() { s.Search(ctx, SearchQuery{Query: "q"}) })
		results := make(chan SearchResult, 8)
		for range 8 {
			workers.Go(func() { results <- s.Search(t.Context(), SearchQuery{Query: "q"}) })
		}
		synctest.Wait()
		cancel()
		synctest.Wait()
		close(release)
		workers.Wait()
		if calls.Load() != 1 {
			t.Errorf("Search concurrent misses = %d provider calls, want 1", calls.Load())
		}
		for range 8 {
			if got := <-results; len(got.Titles) != 1 || len(got.DegradedProviders) != 0 {
				t.Errorf("Search after sibling cancellation = %+v, want usable result", got)
			}
		}
	})
}

func TestStaleResponseDoesNotWaitForRefresh(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		release := make(chan struct{})
		var calls atomic.Int32
		p := &fakeProvider{name: "up", searchFn: func(ctx context.Context, _ SearchQuery) ([]Title, error) {
			if calls.Add(1) == 1 {
				return []Title{{ID: "up:1", Title: "Old"}}, nil
			}
			select {
			case <-release:
				return []Title{{ID: "up:1", Title: "New"}}, nil
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}}
		s := NewService([]Provider{p}, Options{CacheTTL: time.Second})
		defer s.Close()
		query := SearchQuery{Query: "q"}
		s.Search(t.Context(), query)
		time.Sleep(2 * time.Second)
		result := s.Search(t.Context(), query)
		if len(result.Titles) != 1 || result.Titles[0].Title != "Old" {
			t.Errorf("Search expired cache = %+v, want Old immediately", result)
		}
		synctest.Wait()
		for range 5 {
			s.Search(t.Context(), query)
		}
		synctest.Wait()
		if calls.Load() != 2 {
			t.Errorf("Search stale refresh calls = %d, want 2 including prime", calls.Load())
		}
		close(release)
		synctest.Wait()
		result = s.Search(t.Context(), query)
		if len(result.Titles) != 1 || result.Titles[0].Title != "New" {
			t.Errorf("Search refreshed cache = %+v, want New", result)
		}
	})
}

func TestProviderCooldownSkipsOtherKeysAndRecovers(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var calls atomic.Int32
		p := &fakeProvider{name: "down", searchFn: func(context.Context, SearchQuery) ([]Title, error) {
			if calls.Add(1) == 1 {
				return nil, errors.New("network unavailable")
			}
			return []Title{{ID: "up:1", Title: "Recovered"}}, nil
		}}
		s := NewService([]Provider{p}, Options{FailureTTL: time.Second})
		defer s.Close()
		s.Search(t.Context(), SearchQuery{Query: "first"})
		s.Search(t.Context(), SearchQuery{Query: "other"})
		if calls.Load() != 1 {
			t.Errorf("Search during outage = %d calls, want 1 across keys", calls.Load())
		}
		time.Sleep(2 * time.Second)
		result := s.Search(t.Context(), SearchQuery{Query: "other"})
		if calls.Load() != 2 || len(result.Titles) != 1 {
			t.Errorf("Search after cooldown = %d calls, %+v; want recovery", calls.Load(), result)
		}
	})
}

func TestEpisodesKeepFastDataWithinOneRequestBudget(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		slow := &fakeProvider{name: "slow", detailFn: func(ctx context.Context, _ DetailRequest) (Title, error) { <-ctx.Done(); return Title{}, ctx.Err() }}
		fast := &fakeProvider{name: "fast", episodeFn: func(context.Context, EpisodeRequest) ([]Episode, error) {
			return []Episode{{ID: "fast:1", Season: 1, Episode: 1}}, nil
		}}
		s := NewService([]Provider{slow, fast}, Options{RequestTimeout: time.Second})
		defer s.Close()
		start := time.Now()
		result := s.Episodes(t.Context(), "fast:1", 1)
		if elapsed := time.Since(start); elapsed != time.Second {
			t.Errorf("Episodes duration = %s, want shared 1s budget", elapsed)
		}
		if len(result.Episodes) != 1 || result.Episodes[0].TitleID != "fast:1" {
			t.Errorf("Episodes after metadata timeout = %+v, want fast result", result)
		}
	})
}

func TestCloseCancelsAndJoinsProviderWork(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var exited atomic.Bool
		p := &fakeProvider{name: "slow", searchFn: func(ctx context.Context, _ SearchQuery) ([]Title, error) {
			<-ctx.Done()
			exited.Store(true)
			return nil, ctx.Err()
		}}
		s := NewService([]Provider{p}, Options{})
		done := make(chan struct{})
		go func() { s.Search(t.Context(), SearchQuery{Query: "q"}); close(done) }()
		synctest.Wait()
		s.Close()
		<-done
		if !exited.Load() {
			t.Error("Close returned before provider exited")
		}
	})
}

func TestAnimeProvidersSkipMovieSearchAndJikanClampsLimit(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if got := r.URL.Query().Get("limit"); got != "25" {
			t.Errorf("Jikan Search limit = %q, want 25", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer server.Close()
	// Constructors are initialized normally, then scoped to the local fixture.
	jikan := NewJikan(JikanOptions{HTTP: server.Client(), BaseURL: server.URL})
	anilist := NewAniList(AniListOptions{HTTP: server.Client(), BaseURL: server.URL})
	s := NewService([]Provider{jikan, anilist}, Options{})
	defer s.Close()
	result := s.Search(t.Context(), SearchQuery{Query: "movie", Type: TypeMovie})
	if calls.Load() != 0 || len(result.DegradedProviders) != 0 {
		t.Errorf("Movie search anime calls = %d, result %+v; want skipped", calls.Load(), result)
	}
	_, err := jikan.Search(t.Context(), SearchQuery{Query: "anime", Limit: 50})
	if err != nil {
		t.Fatalf("Jikan Search fixture = %v, want success", err)
	}
}

func TestProviderHTTPDoesNotRetryClientErrorsAndHonorsRetryAfter(t *testing.T) {
	for _, status := range []int{http.StatusBadRequest, http.StatusTooManyRequests} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.Header().Set("Retry-After", "90")
				w.WriteHeader(status)
			}))
			defer server.Close()
			var target any
			err := fetchJSON(t.Context(), server.Client(), server.URL, &target)
			if err == nil || calls.Load() != 1 {
				t.Errorf("fetchJSON(%d) = %v, %d calls; want one failed call", status, err, calls.Load())
			}
			if status == 429 {
				var limited *rateLimitError
				if !errors.As(err, &limited) || limited.retryAfter != 90*time.Second {
					t.Errorf("fetchJSON(429) = %v, want Retry-After 90s", err)
				}
			}
		})
	}
}

func TestRateLimitCooldownHonorsServerDuration(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var calls atomic.Int32
		p := &fakeProvider{name: "limited", searchFn: func(context.Context, SearchQuery) ([]Title, error) {
			calls.Add(1)
			return nil, &rateLimitError{retryAfter: 90 * time.Second}
		}}
		s := NewService([]Provider{p}, Options{FailureTTL: time.Second})
		defer s.Close()
		s.Search(t.Context(), SearchQuery{Query: "one"})
		time.Sleep(60 * time.Second)
		s.Search(t.Context(), SearchQuery{Query: "two"})
		if calls.Load() != 1 {
			t.Errorf("Search before Retry-After = %d calls, want 1", calls.Load())
		}
		time.Sleep(31 * time.Second)
		s.Search(t.Context(), SearchQuery{Query: "two"})
		if calls.Load() != 2 {
			t.Errorf("Search after Retry-After = %d calls, want 2", calls.Load())
		}
	})
}

func TestClientErrorDoesNotDisableOtherSearches(t *testing.T) {
	var calls atomic.Int32
	p := &fakeProvider{name: "up", searchFn: func(_ context.Context, q SearchQuery) ([]Title, error) {
		calls.Add(1)
		if q.Query == "invalid" {
			return nil, &providerStatusError{code: 400, message: "bad request"}
		}
		return []Title{{ID: "up:1", Title: "Valid"}}, nil
	}}
	s := NewService([]Provider{p}, Options{})
	defer s.Close()
	s.Search(t.Context(), SearchQuery{Query: "invalid"})
	result := s.Search(t.Context(), SearchQuery{Query: "valid"})
	if calls.Load() != 2 || len(result.Titles) != 1 {
		t.Errorf("Search after unrelated client error = %d calls, %+v; want Valid", calls.Load(), result)
	}
}

func TestCachedEpisodesDoNotRepeatMetadataTimeoutOrShareMaps(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var metadataCalls, episodeCalls atomic.Int32
		slow := &fakeProvider{name: "slow", detailFn: func(ctx context.Context, _ DetailRequest) (Title, error) {
			metadataCalls.Add(1)
			<-ctx.Done()
			return Title{}, ctx.Err()
		}}
		fast := &fakeProvider{name: "fast", episodeFn: func(context.Context, EpisodeRequest) ([]Episode, error) {
			episodeCalls.Add(1)
			return []Episode{{ID: "fast:1", Season: 1, Episode: 1, ProviderIDs: map[string]string{"fast": "1"}}}, nil
		}}
		s := NewService([]Provider{slow, fast}, Options{RequestTimeout: time.Second})
		defer s.Close()
		first := s.Episodes(t.Context(), "fast:1", 1)
		if len(first.Episodes) != 1 {
			t.Fatalf("Episodes first = %+v, want one usable episode", first)
		}
		first.Episodes[0].ProviderIDs["fast"] = "outside"
		callsBefore := metadataCalls.Load()
		start := time.Now()
		second := s.Episodes(t.Context(), "fast:1", 1)
		if time.Since(start) != 0 || metadataCalls.Load() != callsBefore || episodeCalls.Load() != 1 {
			t.Errorf("Episodes repeat took %s, calls (%d,%d); want immediate cached response", time.Since(start), metadataCalls.Load(), episodeCalls.Load())
		}
		if len(second.Episodes) != 1 || second.Episodes[0].ProviderIDs["fast"] != "1" {
			t.Errorf("Episodes cache = %+v, want original provider map", second)
		}
	})
}

func TestProviderCooldownDoesNotDegradeUnsupportedIDs(t *testing.T) {
	jikan := NewJikan(JikanOptions{})
	s := NewService([]Provider{jikan}, Options{})
	defer s.Close()
	s.failures.Set("jikan", "availability", providerFailure{err: ErrRateLimited}, time.Minute)
	episodes := s.EpisodesWithIDs(t.Context(), map[string]string{"tmdb": "tv:1399"}, 1, "tmdb:tv:1399")
	detail := s.Detail(t.Context(), "tmdb:tv:1399")
	if len(episodes.DegradedProviders) != 0 || len(detail.DegradedProviders) != 0 || !detail.NotFound {
		t.Errorf("Unsupported IDs during Jikan outage = episodes %+v, detail %+v; want clean unsupported result", episodes, detail)
	}
}
