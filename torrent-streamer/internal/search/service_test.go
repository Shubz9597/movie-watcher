package search

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestSearchRunsVariantsConcurrentlyWithoutGrabbing(t *testing.T) {
	t.Parallel()

	var (
		active        atomic.Int32
		maximumActive atomic.Int32
		downloadCalls atomic.Int32
		started       = make(chan struct{})
		startedOnce   sync.Once
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/download") {
			downloadCalls.Add(1)
			http.Error(w, "search must not grab", http.StatusInternalServerError)
			return
		}
		if r.URL.Path != "/api/v1/search" {
			http.NotFound(w, r)
			return
		}
		current := active.Add(1)
		defer active.Add(-1)
		for {
			maximum := maximumActive.Load()
			if current <= maximum || maximumActive.CompareAndSwap(maximum, current) {
				break
			}
		}
		if current >= 2 {
			startedOnce.Do(func() { close(started) })
		}
		select {
		case <-started:
		case <-r.Context().Done():
			return
		}
		_ = json.NewEncoder(w).Encode([]prowlarrRelease{{
			Title: "Dragon Ball 02 1080p", Indexer: "test", Protocol: "torrent",
			InfoHash: "0123456789abcdef0123456789abcdef01234567", Seeders: 10,
		}})
	}))
	t.Cleanup(server.Close)

	service := newTestService(t, server.URL)
	episode := 2
	response, err := service.Search(context.Background(), Request{
		Kind: KindAnime, Title: "Dragon Ball", Aliases: []string{"Doragon Boru", "Dragonball"},
		Episode: &episode, Absolute: &episode,
	})
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}
	if maximumActive.Load() < 2 {
		t.Fatalf("maximum concurrent searches = %d, want at least 2", maximumActive.Load())
	}
	if downloadCalls.Load() != 0 {
		t.Fatalf("download calls during search = %d, want 0", downloadCalls.Load())
	}
	if len(response.Results) != 1 {
		t.Fatalf("len(results) = %d, want 1 deduplicated result", len(response.Results))
	}
	result := response.Results[0]
	if result.MagnetURI == "" || result.SourceID != "" {
		t.Fatalf("result source = %#v, want synthesized magnet without source ID", result)
	}
	if result.EpisodeMatch == nil || !*result.EpisodeMatch {
		t.Fatalf("episodeMatch = %v, want true for loose anime episode title", result.EpisodeMatch)
	}
}

func TestNormalizeDeduplicatesMirrorsAndKeepsBestSource(t *testing.T) {
	t.Parallel()

	service := &Service{sources: make(map[string]sourceEntry), now: time.Now, sourceTTL: time.Minute}
	results := service.normalize(Request{Kind: KindMovie, Title: "Example"}, []prowlarrRelease{
		{Title: "Example.Movie.2026.1080p", Indexer: "one", Protocol: "torrent", InfoHash: "1111111111111111111111111111111111111111", Size: 1000, Seeders: 4},
		{Title: "Example Movie 2026 1080p", Indexer: "two", Protocol: "torrent", InfoHash: "2222222222222222222222222222222222222222", Size: 1000, Seeders: 40, MagnetURL: "magnet:?xt=urn:btih:2222222222222222222222222222222222222222"},
		{Title: "Different mirror name", Indexer: "three", Protocol: "torrent", InfoHash: "2222222222222222222222222222222222222222", Size: 1000, Seeders: 20},
	})

	if len(results) != 1 {
		t.Fatalf("len(results) = %d, want 1 mirrored release", len(results))
	}
	if results[0].Indexer != "two" || results[0].Seeders != 40 || results[0].MagnetURI == "" {
		t.Fatalf("result = %#v, want the most-seeded direct magnet", results[0])
	}
}

func TestResolveGrabsOnlySelectedSourceAndCachesMagnet(t *testing.T) {
	t.Parallel()

	const infoHash = "89ABCDEF0123456789ABCDEF0123456789ABCDEF"
	var (
		server        *httptest.Server
		downloadCalls atomic.Int32
	)
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/v1/search":
			_ = json.NewEncoder(w).Encode([]prowlarrRelease{{
				Title: "Selected release", Indexer: "test", Protocol: "torrent",
				DownloadURL: server.URL + "/api/v1/indexer/3/download/selected",
			}})
		case r.URL.Path == "/api/v1/indexer/3/download/selected":
			downloadCalls.Add(1)
			w.Header().Set("Location", "magnet:?xt=urn:btih:"+infoHash)
			w.WriteHeader(http.StatusFound)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	service := newTestService(t, server.URL)
	searchResponse, err := service.Search(context.Background(), Request{Kind: KindMovie, Title: "Selected"})
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}
	if len(searchResponse.Results) != 1 || searchResponse.Results[0].SourceID == "" {
		t.Fatalf("search result = %#v, want one opaque source", searchResponse.Results)
	}
	encoded, err := json.Marshal(searchResponse)
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	if strings.Contains(string(encoded), "/download/") || strings.Contains(string(encoded), server.URL) {
		t.Fatalf("renderer response leaked backend download URL: %s", encoded)
	}

	request := ResolveRequest{SourceID: searchResponse.Results[0].SourceID}
	for attempt := 0; attempt < 2; attempt++ {
		resolved, resolveErr := service.Resolve(context.Background(), request)
		if resolveErr != nil {
			t.Fatalf("Resolve() attempt %d error = %v", attempt+1, resolveErr)
		}
		if resolved.InfoHash != infoHash || resolved.MagnetURI == "" {
			t.Fatalf("Resolve() = %#v, want selected magnet", resolved)
		}
	}
	if downloadCalls.Load() != 1 {
		t.Fatalf("download calls after two resolves = %d, want 1", downloadCalls.Load())
	}
}

func TestSearchHonorsCanceledContext(t *testing.T) {
	t.Parallel()

	requestStarted := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(requestStarted)
		<-r.Context().Done()
	}))
	t.Cleanup(server.Close)
	service := newTestService(t, server.URL)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := service.Search(ctx, Request{Kind: KindMovie, Title: "Canceled"})
		done <- err
	}()
	select {
	case <-requestStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("Prowlarr request did not start")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Search() error = %v, want context cancellation", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Search() did not return after cancellation")
	}
}

func newTestService(t *testing.T, baseURL string) *Service {
	t.Helper()
	service, err := NewService(baseURL, "test-api-key", &http.Client{Timeout: 3 * time.Second})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	return service
}
