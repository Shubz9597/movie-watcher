package catalog

import (
	"context"
	"fmt"
	"testing"
	"time"
)

// Fixed-latency providers isolate orchestration/cache cost from internet noise.
func benchmarkProviders() []Provider {
	providers := make([]Provider, 4)
	for i := range providers {
		name := fmt.Sprintf("provider-%d", i)
		wait := func(ctx context.Context) error {
			select {
			case <-time.After(time.Millisecond):
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		providers[i] = &fakeProvider{name: name,
			searchFn: func(ctx context.Context, _ SearchQuery) ([]Title, error) {
				return []Title{{ID: "tmdb:movie:1", Title: "Film", Type: TypeMovie}}, wait(ctx)
			},
			detailFn: func(ctx context.Context, _ DetailRequest) (Title, error) {
				return Title{ID: "tmdb:movie:1", Title: "Film", Type: TypeMovie, ProviderIDs: map[string]string{"tmdb": "movie:1"}}, wait(ctx)
			},
			episodeFn: func(ctx context.Context, _ EpisodeRequest) ([]Episode, error) {
				return []Episode{{ID: "tmdb:ep:1", Season: 1, Episode: 1}}, wait(ctx)
			},
			sectionFn: func(ctx context.Context, _ string) ([]Title, error) {
				return []Title{{ID: "tmdb:movie:1", Title: "Film", Type: TypeMovie}}, wait(ctx)
			},
		}
	}
	return providers
}

func BenchmarkCatalogSearchCold(b *testing.B) {
	providers := benchmarkProviders()
	for b.Loop() {
		s := NewService(providers, Options{})
		s.Search(context.Background(), SearchQuery{Query: "Film"})
		if closer, ok := any(s).(interface{ Close() }); ok {
			closer.Close()
		}
	}
}

func BenchmarkCatalogSectionCold(b *testing.B) {
	providers := benchmarkProviders()
	for b.Loop() {
		s := NewService(providers, Options{})
		s.Section(context.Background(), "trending")
		if closer, ok := any(s).(interface{ Close() }); ok {
			closer.Close()
		}
	}
}

func BenchmarkCatalogDetailWarm(b *testing.B) {
	s := NewService(benchmarkProviders(), Options{})
	s.Detail(context.Background(), "tmdb:movie:1")
	b.Cleanup(func() {
		if closer, ok := any(s).(interface{ Close() }); ok {
			closer.Close()
		}
	})
	for b.Loop() {
		s.Detail(context.Background(), "tmdb:movie:1")
	}
}

func BenchmarkCatalogEpisodesCold(b *testing.B) {
	providers := benchmarkProviders()
	for b.Loop() {
		s := NewService(providers, Options{})
		s.EpisodesWithIDs(context.Background(), map[string]string{"tmdb": "tv:1"}, 1, "tmdb:tv:1")
		if closer, ok := any(s).(interface{ Close() }); ok {
			closer.Close()
		}
	}
}
