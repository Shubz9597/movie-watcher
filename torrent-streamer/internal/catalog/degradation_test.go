package catalog

import (
	"context"
	"errors"
	"testing"
	"time"
)

type fakeProvider struct {
	name      string
	searchFn  func(ctx context.Context, query SearchQuery) ([]Title, error)
	detailFn  func(ctx context.Context, request DetailRequest) (Title, error)
	episodeFn func(ctx context.Context, request EpisodeRequest) ([]Episode, error)
	sectionFn func(ctx context.Context, kind string) ([]Title, error)
}

func (f *fakeProvider) Name() string { return f.name }

func (f *fakeProvider) Search(ctx context.Context, query SearchQuery) ([]Title, error) {
	if f.searchFn == nil {
		return nil, errors.New("not supported")
	}
	return f.searchFn(ctx, query)
}

func (f *fakeProvider) Detail(ctx context.Context, request DetailRequest) (Title, error) {
	if f.detailFn == nil {
		return Title{}, errors.New("not supported")
	}
	return f.detailFn(ctx, request)
}

func (f *fakeProvider) Episodes(ctx context.Context, request EpisodeRequest) ([]Episode, error) {
	if f.episodeFn == nil {
		return nil, errors.New("not supported")
	}
	return f.episodeFn(ctx, request)
}

func (f *fakeProvider) Section(ctx context.Context, kind string) ([]Title, error) {
	if f.sectionFn == nil {
		return nil, errors.New("not supported")
	}
	return f.sectionFn(ctx, kind)
}

func title(name, id string) Title {
	return Title{ID: id, Type: TypeMovie, Title: name, ProviderIDs: map[string]string{id: name}, MergedFrom: []string{id}}
}

func TestServiceSearchPartialOutageServesRemainingProviders(t *testing.T) {
	up := &fakeProvider{name: "up", searchFn: func(ctx context.Context, query SearchQuery) ([]Title, error) {
		return []Title{title("Up Title", "tmdb:1")}, nil
	}}
	down := &fakeProvider{name: "down", searchFn: func(ctx context.Context, query SearchQuery) ([]Title, error) {
		return nil, errors.New("connection refused")
	}}
	service := NewService([]Provider{up, down}, Options{ProviderTimeout: 50 * time.Millisecond})

	result := service.Search(context.Background(), SearchQuery{Query: "q"})
	if len(result.Titles) != 1 || result.Titles[0].ID != "tmdb:1" {
		t.Fatalf("remaining providers must still serve: %+v", result)
	}
	if len(result.DegradedProviders) != 1 || result.DegradedProviders[0] != "down" {
		t.Fatalf("degraded providers wrong: %v", result.DegradedProviders)
	}
}

func TestServiceSearchStaleCacheFallbackOnOutage(t *testing.T) {
	var calls int
	provider := &fakeProvider{name: "flaky", searchFn: func(ctx context.Context, query SearchQuery) ([]Title, error) {
		calls++
		if calls == 1 {
			return []Title{title("Cached Title", "anilist:9")}, nil
		}
		return nil, errors.New("provider down")
	}}
	service := NewService([]Provider{provider}, Options{ProviderTimeout: 50 * time.Millisecond, CacheTTL: 40 * time.Millisecond})

	first := service.Search(context.Background(), SearchQuery{Query: "q"})
	if len(first.Titles) != 1 {
		t.Fatalf("prime cache failed: %+v", first)
	}
	time.Sleep(60 * time.Millisecond)
	second := service.Search(context.Background(), SearchQuery{Query: "q"})
	if len(second.Titles) != 1 || second.Titles[0].ID != "anilist:9" {
		t.Fatalf("stale-but-valid cache must be served on outage: %+v", second)
	}
	if len(second.DegradedProviders) != 1 || second.DegradedProviders[0] != "flaky" {
		t.Fatalf("outage must mark provider degraded: %v", second.DegradedProviders)
	}
}

func TestServiceSearchAllProvidersFailedMeansNoResultsForHandler(t *testing.T) {
	down := &fakeProvider{name: "down", searchFn: func(ctx context.Context, query SearchQuery) ([]Title, error) {
		return nil, errors.New("down")
	}}
	service := NewService([]Provider{down}, Options{ProviderTimeout: 50 * time.Millisecond})
	result := service.Search(context.Background(), SearchQuery{Query: "q"})
	if len(result.Titles) != 0 || len(result.DegradedProviders) != 1 {
		t.Fatalf("all-failed = %+v", result)
	}
}

func TestServiceSearchRateLimitedIsDegradation(t *testing.T) {
	limited := &fakeProvider{name: "limited", searchFn: func(ctx context.Context, query SearchQuery) ([]Title, error) {
		return nil, ErrRateLimited
	}}
	service := NewService([]Provider{limited}, Options{ProviderTimeout: 50 * time.Millisecond})
	result := service.Search(context.Background(), SearchQuery{Query: "q"})
	if len(result.Titles) != 0 || len(result.DegradedProviders) != 1 {
		t.Fatalf("rate limit must degrade, not panic: %+v", result)
	}
}

func TestServiceProviderTimeoutBoundsSlowProvider(t *testing.T) {
	slow := &fakeProvider{name: "slow", searchFn: func(ctx context.Context, query SearchQuery) ([]Title, error) {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(5 * time.Second):
			return []Title{title("Late", "jikan:1")}, nil
		}
	}}
	service := NewService([]Provider{slow}, Options{ProviderTimeout: 30 * time.Millisecond})
	start := time.Now()
	result := service.Search(context.Background(), SearchQuery{Query: "q"})
	if time.Since(start) > 2*time.Second {
		t.Fatalf("timeout not enforced: %v", time.Since(start))
	}
	if len(result.Titles) != 0 || len(result.DegradedProviders) != 1 {
		t.Fatalf("timed-out provider must degrade: %+v", result)
	}
}

func TestServiceDetailNotFoundVersusOutage(t *testing.T) {
	missing := &fakeProvider{name: "missing", detailFn: func(ctx context.Context, request DetailRequest) (Title, error) {
		return Title{}, ErrNotFound
	}}
	service := NewService([]Provider{missing}, Options{ProviderTimeout: 50 * time.Millisecond})
	result := service.Detail(context.Background(), "tmdb:999")
	if !result.NotFound || result.Found {
		t.Fatalf("all-not-found must report NotFound: %+v", result)
	}

	broken := &fakeProvider{name: "broken", detailFn: func(ctx context.Context, request DetailRequest) (Title, error) {
		return Title{}, errors.New("boom")
	}}
	service = NewService([]Provider{broken}, Options{ProviderTimeout: 50 * time.Millisecond})
	result = service.Detail(context.Background(), "tmdb:1")
	if result.Found || result.NotFound {
		t.Fatalf("outage must be neither found nor clean-404: %+v", result)
	}
	if len(result.DegradedProviders) != 1 {
		t.Fatalf("outage must be recorded degraded: %+v", result)
	}
}

func TestServiceDetailMergesEnrichment(t *testing.T) {
	primary := &fakeProvider{name: "primary", detailFn: func(ctx context.Context, request DetailRequest) (Title, error) {
		return Title{ID: "anilist:154587", Type: TypeAnime, Title: "Frieren", ProviderIDs: map[string]string{"anilist": "154587"}, MergedFrom: []string{"anilist"}}, nil
	}}
	enricher := &fakeProvider{name: "enricher", detailFn: func(ctx context.Context, request DetailRequest) (Title, error) {
		if request.ProviderIDs["anilist"] != "154587" {
			return Title{}, ErrNotFound
		}
		return Title{ID: "anizip:154587", IMDBID: "tt28015436", ProviderIDs: map[string]string{"anizip": "154587"}, MergedFrom: []string{"anizip"}}, nil
	}}
	service := NewService([]Provider{primary, enricher}, Options{ProviderTimeout: 50 * time.Millisecond})
	result := service.Detail(context.Background(), "anilist:154587")
	if !result.Found || result.Title.IMDBID != "tt28015436" {
		t.Fatalf("enrichment not merged: %+v", result)
	}
}

func TestServiceEpisodesMergesAndDegrades(t *testing.T) {
	good := &fakeProvider{name: "good", episodeFn: func(ctx context.Context, request EpisodeRequest) ([]Episode, error) {
		return []Episode{{
			ID: "tmdb:209867:1:1", Season: 1, Episode: 1, Title: "The Journey's End",
			ProviderIDs: map[string]string{"tmdb": "209867"},
		}}, nil
	}}
	down := &fakeProvider{name: "down", episodeFn: func(ctx context.Context, request EpisodeRequest) ([]Episode, error) {
		return nil, errors.New("down")
	}}
	service := NewService([]Provider{good, down}, Options{ProviderTimeout: 50 * time.Millisecond})
	result := service.Episodes(context.Background(), "tmdb:209867", 1)
	if len(result.Episodes) != 1 || result.Episodes[0].TitleID != "tmdb:209867" {
		t.Fatalf("episodes wrong: %+v", result)
	}
	if len(result.DegradedProviders) != 1 || result.DegradedProviders[0] != "down" {
		t.Fatalf("degradation wrong: %v", result.DegradedProviders)
	}
}

func TestServiceSectionDeterministicIDs(t *testing.T) {
	p1 := &fakeProvider{name: "p1", sectionFn: func(ctx context.Context, kind string) ([]Title, error) {
		return []Title{title("A", "tmdb:2"), title("B", "tmdb:1")}, nil
	}}
	service := NewService([]Provider{p1}, Options{ProviderTimeout: 50 * time.Millisecond})
	result := service.Section(context.Background(), "trending")
	if len(result.TitleIDs) != 2 || result.TitleIDs[0] != "tmdb:1" || result.TitleIDs[1] != "tmdb:2" {
		t.Fatalf("section ids = %v", result.TitleIDs)
	}
}

func TestServiceMergeNotDependentOnMapIteration(t *testing.T) {
	provider := &fakeProvider{name: "p", searchFn: func(ctx context.Context, query SearchQuery) ([]Title, error) {
		return []Title{title("A", "tmdb:3"), title("B", "tmdb:1"), title("C", "tmdb:2")}, nil
	}}
	service := NewService([]Provider{provider}, Options{ProviderTimeout: 50 * time.Millisecond})
	first := service.Search(context.Background(), SearchQuery{Query: "q"})
	for iteration := 0; iteration < 10; iteration++ {
		again := service.Search(context.Background(), SearchQuery{Query: "q"})
		if len(again.Titles) != len(first.Titles) {
			t.Fatal("result count differs between runs")
		}
		for i := range first.Titles {
			if again.Titles[i].ID != first.Titles[i].ID {
				t.Fatalf("ordering differs between runs: %v vs %v", first.Titles, again.Titles)
			}
		}
	}
}

func TestNewServiceDefaultsAreDocumented(t *testing.T) {
	options := Options{}.withDefaults()
	if options.ProviderTimeout != 8*time.Second || options.CacheTTL != 10*time.Minute ||
		options.CacheMaxEntries != 512 || options.SearchLimit != 50 {
		t.Fatalf("defaults drifted: %+v", options)
	}
}
