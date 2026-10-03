package catalog

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"testing"
	"time"
)

func TestRegressionCachedCatalogOwnership(t *testing.T) {
	a := Title{ID: "tmdb:movie:1", Title: "Film", Type: TypeMovie, Year: 2020, ProviderIDs: map[string]string{"tmdb": "movie:1"}, Artwork: map[string]string{"poster": "a"}}
	b := Title{ID: "imdb:tt1", Title: "Film", Type: TypeMovie, Year: 2020, ProviderIDs: map[string]string{"imdb": "tt1"}, Artwork: map[string]string{"background": "b"}}
	MergeTitles([][]Title{{a}, {b}})
	if a.ProviderIDs["imdb"] != "" || a.Artwork["background"] != "" {
		t.Errorf("MergeTitles mutated cached provider input: ids=%v artwork=%v, want input unchanged", a.ProviderIDs, a.Artwork)
	}
}
func TestRegressionConcurrentCachedCatalog(t *testing.T) {
	s := NewService([]Provider{&fakeProvider{name: "a"}, &fakeProvider{name: "b"}}, Options{})
	q := SearchQuery{Query: "Film", Limit: 50}
	var a, b []Title
	for i := 0; i < 300; i++ {
		a = append(a, Title{ID: fmt.Sprintf("tmdb:movie:%d", i+1), Title: fmt.Sprintf("Film %d", i), Type: TypeMovie, ProviderIDs: map[string]string{"tmdb": "a"}, Artwork: map[string]string{"poster": "a"}})
		b = append(b, Title{ID: fmt.Sprintf("imdb:tt%d", i+1), Title: fmt.Sprintf("Film %d", i), Type: TypeMovie, ProviderIDs: map[string]string{"imdb": "b"}, Artwork: map[string]string{"background": "b"}})
	}
	s.cache.Set("a", searchCacheKey(q), a, time.Hour)
	s.cache.Set("b", searchCacheKey(q), b, time.Hour)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); <-start; r := s.Search(context.Background(), q); _, _ = json.Marshal(r) }()
	}
	close(start)
	wg.Wait()
}

func TestCacheCopiesMutableFieldsOnEntryAndExit(t *testing.T) {
	cache := NewCache(10)
	original := Title{ID: "tmdb:movie:1", Artwork: map[string]string{"poster": "original"}, ProviderIDs: map[string]string{"tmdb": "movie:1"}, ExternalLinks: map[string]string{"web": "original"}, Genres: []string{"drama"}, AltTitles: []string{"original"}, MergedFrom: []string{"tmdb"}, Seasons: []Season{{Number: 1}}}
	cache.Set("tmdb", "title", original, time.Hour)
	original.Artwork["poster"] = "outside"
	original.Genres[0] = "outside"
	first, _, _ := cache.Get("tmdb", "title")
	a := first.(Title)
	if a.Artwork["poster"] != "original" || a.Genres[0] != "drama" {
		t.Fatal("cache retained caller's mutable fields")
	}
	a.Artwork["poster"] = "changed"
	a.ProviderIDs["extra"] = "changed"
	a.ExternalLinks["web"] = "changed"
	a.Genres[0] = "changed"
	a.AltTitles[0] = "changed"
	a.MergedFrom[0] = "changed"
	a.Seasons[0].Number = 99
	second, _, _ := cache.Get("tmdb", "title")
	b := second.(Title)
	if b.Artwork["poster"] != "original" || b.ProviderIDs["extra"] != "" || b.ExternalLinks["web"] != "original" || b.Genres[0] != "drama" || b.AltTitles[0] != "original" || b.MergedFrom[0] != "tmdb" || b.Seasons[0].Number != 1 {
		t.Fatalf("cache value changed through returned value: %+v", b)
	}
	episodes := []Episode{{ID: "tmdb:ep:1", Season: 1, Episode: 1, ProviderIDs: map[string]string{"tmdb": "1"}}}
	cache.Set("tmdb", "episodes", episodes, time.Hour)
	episodes[0].ProviderIDs["external"] = "changed"
	got, _, _ := cache.Get("tmdb", "episodes")
	if got.([]Episode)[0].ProviderIDs["external"] != "" {
		t.Fatal("episode aliases provider input")
	}
	cache.Set("tmdb", "section", sectionCacheEntry{Titles: []Title{b}, TotalPages: 2}, time.Hour)
	got, _, _ = cache.Get("tmdb", "section")
	got.(sectionCacheEntry).Titles[0].Artwork["poster"] = "changed"
	got, _, _ = cache.Get("tmdb", "section")
	if got.(sectionCacheEntry).Titles[0].Artwork["poster"] != "original" {
		t.Fatal("section aliases cache storage")
	}
}

func TestConcurrentDetailAndEpisodesDoNotShareMaps(t *testing.T) {
	provider := &fakeProvider{name: "tmdb", detailFn: func(context.Context, DetailRequest) (Title, error) {
		return Title{ID: "tmdb:movie:1", Type: TypeMovie, Title: "Film", ProviderIDs: map[string]string{"tmdb": "movie:1"}, Artwork: map[string]string{"poster": "original"}}, nil
	}, episodeFn: func(context.Context, EpisodeRequest) ([]Episode, error) {
		return []Episode{{ID: "tmdb:ep:1", Season: 1, Episode: 1, ProviderIDs: map[string]string{"tmdb": "1"}}}, nil
	}}
	s := NewService([]Provider{provider}, Options{})
	s.Detail(context.Background(), "tmdb:movie:1")
	s.Episodes(context.Background(), "tmdb:movie:1", 1)
	var wg sync.WaitGroup
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			d := s.Detail(context.Background(), "tmdb:movie:1")
			d.Title.Artwork["poster"] = "request-local"
			_, _ = json.Marshal(d)
			e := s.Episodes(context.Background(), "tmdb:movie:1", 1)
			e.Episodes[0].ProviderIDs["external"] = "request-local"
			_, _ = json.Marshal(e)
		}()
	}
	wg.Wait()
}
