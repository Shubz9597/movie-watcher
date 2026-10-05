package search

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestSparseTorrentioSearchMergesAndCachesProwlarr(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/stream/movie/tt1160419.json":
			_, _ = w.Write([]byte(`{"streams":[{"title":"Dune 2021 1080p BluRay\n👤 30 💾 1 GB ⚙️ YTS","infoHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","fileIdx":7}]}`))
		case "/api/v1/indexer":
			mockIndexerList(w, []map[string]any{indexerEntry(1, "YTS", true, "torrent", 1)})
		default:
			calls.Add(1)
			_ = json.NewEncoder(w).Encode([]prowlarrRelease{{Title: "Dune 2021 720p BluRay", Protocol: "torrent", InfoHash: idHex('b'), Seeders: 20, Indexer: "YTS"}})
		}
	}))
	defer server.Close()
	service := newTestService(t, server.URL)
	service.SetTorrentio(&Torrentio{BaseURL: server.URL, HTTP: server.Client()})
	service.SetStore(&memoryStore{payload: map[string][]byte{}, at: map[string]time.Time{}})
	request := Request{Kind: KindMovie, Title: "Dune", Year: 2021, IMDBID: "tt1160419", OriginalLanguage: "en"}
	for range 2 {
		response, err := service.Search(context.Background(), request)
		if err != nil || len(response.Results) != 2 || calls.Load() != 1 {
			t.Fatalf("search returned %d choices, err=%v, Prowlarr calls=%d", len(response.Results), err, calls.Load())
		}
		if response.Results[0].FileIndex == nil || *response.Results[0].FileIndex != 7 {
			t.Fatalf("lost Torrentio file index: %+v", response.Results)
		}
	}
	stored, _, ok := service.loadStored(context.Background(), searchKey(request))
	if !ok || len(stored) != 2 {
		t.Fatalf("stored %d releases, ok=%v", len(stored), ok)
	}
}

func TestAnimeCacheKeysIncludeCatalogIdentity(t *testing.T) {
	a := Request{Kind: KindAnime, Title: "Shared title", AniListID: 100}
	b := a
	b.AniListID = 101
	if searchKey(a) == searchKey(b) {
		t.Fatal("different AniList entries share torrent results")
	}
}

func TestTorrentioMappingRetriesTransientResponses(t *testing.T) {
	t.Parallel()
	for _, status := range []int{http.StatusTooManyRequests, http.StatusBadGateway, http.StatusOK} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if calls.Add(1) == 1 {
					w.WriteHeader(status)
					_, _ = w.Write([]byte(`invalid-json`))
					return
				}
				_, _ = w.Write([]byte(`{"mappings":{"kitsu_id":123}}`))
			}))
			defer server.Close()
			source := &Torrentio{AniZipURL: server.URL, HTTP: server.Client()}
			if source.kitsuID(context.Background(), 1) != 0 {
				t.Fatal("invalid first mapping accepted")
			}
			if got := source.kitsuID(context.Background(), 1); got != 123 {
				t.Fatalf("transient failure was cached: kitsu=%d calls=%d", got, calls.Load())
			}
		})
	}
}

func TestSparseTorrentioReturnsBeforeSlowPrimaryAndKeepsLateResults(t *testing.T) {
	t.Parallel()
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/stream/movie/tt1160419.json":
			_, _ = w.Write([]byte(`{"streams":[{"title":"Dune 2021 1080p BluRay\n👤 30 💾 1 GB ⚙️ YTS","infoHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","fileIdx":7}]}`))
		case "/api/v1/indexer":
			mockIndexerList(w, []map[string]any{indexerEntry(1, "YTS", true, "torrent", 1)})
		default:
			<-release
			_ = json.NewEncoder(w).Encode([]prowlarrRelease{{Title: "Dune 2021 720p BluRay", Protocol: "torrent", InfoHash: idHex('b'), Seeders: 20}})
		}
	}))
	t.Cleanup(server.Close)
	t.Cleanup(func() {
		select {
		case <-release:
		default:
			close(release)
		}
	})
	service := newTestService(t, server.URL)
	service.softDeadline = 20 * time.Millisecond
	service.SetTorrentio(&Torrentio{BaseURL: server.URL, HTTP: server.Client()})
	request := Request{Kind: KindMovie, Title: "Dune", Year: 2021, IMDBID: "tt1160419"}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	response, err := service.Search(ctx, request)
	if err != nil || len(response.Results) != 1 {
		t.Fatalf("early choices=%d err=%v", len(response.Results), err)
	}
	close(release)
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if results, ok := service.cached(searchKey(request)); ok && len(results) == 2 {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("late Prowlarr collector overwrote or failed to merge Torrentio")
}

func TestSparseTorrentioSurvivesProwlarrOutage(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/stream/movie/tt1160419.json" {
			_, _ = w.Write([]byte(`{"streams":[{"title":"Dune 2021 1080p BluRay","infoHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]}`))
			return
		}
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer server.Close()
	service := newTestService(t, server.URL)
	service.SetTorrentio(&Torrentio{BaseURL: server.URL, HTTP: server.Client()})
	response, err := service.Search(context.Background(), Request{Kind: KindMovie, Title: "Dune", Year: 2021, IMDBID: "tt1160419"})
	if err != nil || len(response.Results) != 1 {
		t.Fatalf("usable addon lost during outage: %+v, %v", response, err)
	}
}

func TestTorrentMirrorKeepsVerifiedFileIndex(t *testing.T) {
	t.Parallel()
	index := 7
	service := newTestService(t, "http://127.0.0.1:9696")
	results := service.normalize(Request{Kind: KindMovie, Title: "Dune", Year: 2021}, []prowlarrRelease{
		{Title: "Dune 2021 1080p BluRay", Protocol: "torrent", InfoHash: idHex('a'), IDMatched: true, FileIndex: &index, Seeders: 10},
		{Title: "Dune 2021 1080p BluRay", Protocol: "torrent", InfoHash: idHex('a'), Seeders: 50},
	})
	if len(results) != 1 || results[0].FileIndex == nil || *results[0].FileIndex != 7 || results[0].Seeders != 50 {
		t.Fatalf("mirror discarded file choice: %+v", results)
	}
}

func TestCanceledViewerDoesNotCancelSharedTorrentSearch(t *testing.T) {
	t.Parallel()
	started := make(chan struct{})
	release := make(chan struct{})
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			close(started)
		}
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		_, _ = w.Write([]byte(`{"streams":[{"title":"Dune 2021 1080p BluRay","infoHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]}`))
	}))
	t.Cleanup(server.Close)
	t.Cleanup(func() {
		select {
		case <-release:
		default:
			close(release)
		}
	})
	service := newTestService(t, "http://127.0.0.1:1")
	service.SetTorrentio(&Torrentio{BaseURL: server.URL, HTTP: server.Client()})
	request := Request{Kind: KindMovie, Title: "Dune", Year: 2021, IMDBID: "tt1160419"}
	firstCtx, cancelFirst := context.WithCancel(context.Background())
	firstDone := make(chan error, 1)
	go func() { _, err := service.Search(firstCtx, request); firstDone <- err }()
	<-started
	cancelFirst()
	if err := <-firstDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled viewer err=%v", err)
	}
	secondCtx, cancelSecond := context.WithTimeout(context.Background(), time.Second)
	defer cancelSecond()
	timer := time.AfterFunc(20*time.Millisecond, func() { close(release) })
	defer timer.Stop()
	response, err := service.Search(secondCtx, request)
	if err != nil || len(response.Results) != 1 || calls.Load() != 1 {
		t.Fatalf("shared search restarted or canceled: choices=%d err=%v calls=%d", len(response.Results), err, calls.Load())
	}
}
