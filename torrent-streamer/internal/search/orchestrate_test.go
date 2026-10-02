package search

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestIndexerRoutingByKind(t *testing.T) {
	t.Parallel()
	episode := 1
	anime := Request{Kind: KindAnime, Title: "x", Episode: &episode}
	animeFilm := Request{Kind: KindAnime, Title: "x"}
	movie := Request{Kind: KindMovie, Title: "x"}
	tv := Request{Kind: KindTV, Title: "x", Episode: &episode}
	cases := []struct {
		indexer string
		request Request
		want    bool
	}{
		{"Nyaa.si", anime, true}, {"Nyaa.si", movie, false}, {"Anime Tosho", tv, false},
		{"SubsPlease", anime, true}, {"YTS", movie, true}, {"YTS", anime, false},
		{"YTS", animeFilm, true}, {"EZTV", tv, true}, {"EZTV", movie, false},
		{"The Pirate Bay", anime, true}, {"The Pirate Bay", movie, true}, {"Knaben", tv, true},
	}
	for _, test := range cases {
		if got := indexerServes(test.indexer, test.request); got != test.want {
			t.Errorf("indexerServes(%q, %s) = %t, want %t", test.indexer, test.request.Kind, got, test.want)
		}
	}
}

func TestBuildQueriesKeepsUsefulTitlesOnly(t *testing.T) {
	t.Parallel()
	movie := buildQueries(Request{Kind: KindMovie, Title: "Interstellar", Year: 2014,
		Aliases: []string{"Interestelar", "Međuzvjezdani", "Medzvezdje"}, OriginalLanguage: "en"})
	if len(movie) != 1 || movie[0].query != "Interstellar 2014" {
		t.Fatalf("movie queries = %+v, want only the primary title", movie)
	}
	episode := 1
	anime := buildQueries(Request{Kind: KindAnime, Title: "Demon Slayer: Kimetsu no Yaiba", Episode: &episode, Absolute: &episode,
		Aliases: []string{"Kimetsu no Yaiba", "鬼滅の刃", "Kimetsu no Yaiba: Yuukaku-hen", "Demon Slayer"}})
	var got []string
	for _, query := range anime {
		got = append(got, query.query)
	}
	if strings.Join(got, "|") != "Demon Slayer: Kimetsu no Yaiba 01|Kimetsu no Yaiba 01|Demon Slayer 01" {
		t.Fatalf("anime queries = %q, want the title and Latin aliases without arcs or native script", got)
	}
}

type memoryStore struct {
	mu      sync.Mutex
	payload map[string][]byte
	at      map[string]time.Time
}

func (m *memoryStore) LoadReleases(_ context.Context, key string) ([]byte, time.Time, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	payload, ok := m.payload[key]
	return payload, m.at[key], ok, nil
}

func (m *memoryStore) SaveReleases(_ context.Context, key string, payload []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.payload[key], m.at[key] = payload, time.Now()
	return nil
}

func (m *memoryStore) saved(key string) []byte {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.payload[key]
}

func TestSearchReturnsEarlyAndFinishesSlowIndexersInBackground(t *testing.T) {
	t.Parallel()
	release := make(chan struct{})
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/v1/indexer":
			mockIndexerList(w, []map[string]any{indexerEntry(1, "YTS", true, "torrent", 1), indexerEntry(2, "Slow Tracker", true, "torrent", 2)})
		case r.URL.Query().Get("indexerIds") == "1":
			_ = json.NewEncoder(w).Encode([]prowlarrRelease{{Title: "Dune (2021) 1080p BRRip x264 -YTS", Indexer: "YTS", Protocol: "torrent", InfoHash: idHex('a'), Seeders: 100}})
		default:
			<-release
			_ = json.NewEncoder(w).Encode([]prowlarrRelease{{Title: "Dune 2021 2160p WEB-DL", Indexer: "Slow Tracker", Protocol: "torrent", InfoHash: idHex('b'), Seeders: 50,
				DownloadURL: "http://indexer/download?apikey=secret"}, {Title: "Dune 2021 720p WEB-DL", Indexer: "Slow Tracker", Protocol: "torrent", DownloadURL: server.URL + "/2/download?apikey=test-api-key&link=abc"}})
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
	service.softDeadline = 50 * time.Millisecond
	store := &memoryStore{payload: map[string][]byte{}, at: map[string]time.Time{}}
	service.SetStore(store)
	request := Request{Kind: KindMovie, Title: "Dune", Year: 2021, OriginalLanguage: "en"}

	started := time.Now()
	response, err := service.Search(context.Background(), request)
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second || len(response.Results) != 1 {
		t.Fatalf("Search() = %d results after %v, want the fast primary result early", len(response.Results), elapsed)
	}
	close(release)
	key := searchKey(request)
	deadline := time.Now().Add(3 * time.Second)
	for store.saved(key) == nil && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	saved := string(store.saved(key))
	if !strings.Contains(saved, "2160p") || !strings.Contains(saved, "720p") || strings.Contains(saved, "test-api-key") || strings.Contains(saved, "indexer/download") {
		t.Fatalf("stored releases = %s, want the full set, grab URLs without the API key, foreign hosts dropped", saved)
	}
	if cached, ok := service.cached(key); !ok || len(cached) != 3 {
		t.Fatalf("cached results = %d, want the completed set of 3", len(cached))
	}
	reloaded, _, ok := service.loadStored(context.Background(), key)
	if !ok || len(reloaded) != 3 {
		t.Fatalf("reloaded = %d releases, want 3", len(reloaded))
	}
	for _, release := range reloaded {
		if release.DownloadURL != "" && !strings.Contains(release.DownloadURL, "apikey=test-api-key") {
			t.Fatalf("reloaded grab URL %q lost its in-memory API key", release.DownloadURL)
		}
	}
}

func TestStaleStoredResultsServeImmediatelyAndRefresh(t *testing.T) {
	t.Parallel()
	var searches atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/indexer" {
			mockIndexerList(w, []map[string]any{indexerEntry(1, "YTS", true, "torrent", 1)})
			return
		}
		searches.Add(1)
		_ = json.NewEncoder(w).Encode([]prowlarrRelease{{Title: "Dune (2021) 1080p BRRip x264 -YTS", Indexer: "YTS", Protocol: "torrent", InfoHash: idHex('n'), Seeders: 120}})
	}))
	t.Cleanup(server.Close)

	service := newTestService(t, server.URL)
	store := &memoryStore{payload: map[string][]byte{}, at: map[string]time.Time{}}
	service.SetStore(store)
	request := Request{Kind: KindMovie, Title: "Dune", Year: 2021, OriginalLanguage: "en"}
	key := searchKey(request)
	old, _ := json.Marshal([]prowlarrRelease{{Title: "Dune (2021) 720p BRRip x264 -YTS", Indexer: "YTS", Protocol: "torrent", InfoHash: idHex('o'), Seeders: 80}})
	store.payload[key], store.at[key] = old, time.Now().Add(-2*time.Hour)

	response, err := service.Search(context.Background(), request)
	if err != nil || len(response.Results) != 1 || response.Results[0].Seeders != 80 {
		t.Fatalf("Search() = %+v, %v; want the stored result served at once", response.Results, err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for !strings.Contains(string(store.saved(key)), "1080p") && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if !strings.Contains(string(store.saved(key)), "1080p") || searches.Load() == 0 {
		t.Fatal("stale stored results were not refreshed in the background")
	}
}
