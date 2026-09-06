package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// newStubBackend builds a deterministic single-backend server implementing
// the public surface the reference client uses (no live providers, no real
// torrents). Heartbeats store progress under the shared household subject so
// cross-client visibility is observable.
func newStubBackend(t *testing.T) *httptest.Server {
	t.Helper()
	var mu sync.Mutex
	progress := map[string]float64{}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/version", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		// Deliberately different application version: compatibility comes
		// from protocol ranges, never app versions (FR-011).
		_, _ = w.Write([]byte(`{"serverVersion":"9.9.9-unrelated","revision":"deadbeef","builtAt":"2026-01-01T00:00:00Z","protocolVersion":1,"supportedProtocolRange":[1,1],"goVersion":"go1.24.2","os":"test","arch":"test","capabilities":["catalog.bff.v2"]}`))
	})
	mux.HandleFunc("GET /v2/catalog/search", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("q") == "" {
			http.Error(w, `{"error":{"code":"invalid_request"}}`, http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"query":"frieren","total":1,"results":[{"id":"tmdb:209867","type":"anime","title":"Frieren: Beyond Journey's End","year":2023,"providerIds":{"tmdb":"209867","anilist":"154587"},"mergedFrom":["tmdb","anilist"]}],"degraded":false,"degradedProviders":[]}`))
	})
	mux.HandleFunc("GET /v2/catalog/titles/tmdb:209867", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"tmdb:209867","type":"anime","title":"Frieren: Beyond Journey's End","year":2023,"imdbId":"tt28015436","providerIds":{"tmdb":"209867"},"mergedFrom":["tmdb"]}`))
	})
	mux.HandleFunc("GET /v2/catalog/titles/tmdb:209867/episodes", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"titleId":"tmdb:209867","season":1,"episodes":[
			{"id":"tmdb:209867:1:1","season":1,"episode":1,"title":"The Journey's End","airDate":"2023-09-29","duration_s":1440},
			{"id":"tmdb:209867:1:2","season":1,"episode":2,"title":"It Would Be Embarrassing","airDate":"2023-10-06","duration_s":1440}
		],"degraded":false,"degradedProviders":[]}`))
	})
	mux.HandleFunc("POST /v1/torrents/resolve", func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			SourceID string `json:"sourceId"`
		}
		_ = json.NewDecoder(r.Body).Decode(&request)
		if request.SourceID == "" {
			http.Error(w, `{"error":{"code":"invalid_request"}}`, http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"magnetUri":"magnet:?xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567","infoHash":"0123456789ABCDEF0123456789ABCDEF01234567"}`))
	})
	mux.HandleFunc("GET /stream", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Range") != "bytes=0-1023" {
			http.Error(w, "invalid range", http.StatusRequestedRangeNotSatisfiable)
			return
		}
		w.Header().Set("Content-Range", "bytes 0-1023/8192")
		w.Header().Set("Accept-Ranges", "bytes")
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write(make([]byte, 1024))
	})
	mux.HandleFunc("POST /v1/session/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		var request HeartbeatRequest
		_ = json.NewDecoder(r.Body).Decode(&request)
		if request.SubjectID == "" || request.SeriesID == "" {
			http.Error(w, `{"error":{"code":"invalid_request"}}`, http.StatusBadRequest)
			return
		}
		mu.Lock()
		progress[request.SubjectID+"\x00"+request.SeriesID] = request.PositionS
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	mux.HandleFunc("GET /v1/resume", func(w http.ResponseWriter, r *http.Request) {
		subject := r.URL.Query().Get("subjectId")
		series := r.URL.Query().Get("seriesId")
		mu.Lock()
		position, ok := progress[subject+"\x00"+series]
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if !ok || position <= 0 {
			_, _ = w.Write([]byte(`{"found":false}`))
			return
		}
		rewound := position - 15
		if rewound < 0 {
			rewound = 0
		}
		_, _ = w.Write([]byte(fmt.Sprintf(`{"found":true,"seriesId":%q,"season":1,"episode":1,"position_s":%.0f,"duration_s":1440,"percent":%.1f}`, series, rewound, rewound/1440*100)))
	})

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server
}

func newTestClient(t *testing.T, server *httptest.Server) *Client {
	t.Helper()
	id, err := LoadOrCreateClientID(t.TempDir())
	if err != nil {
		t.Fatalf("client id: %v", err)
	}
	return &Client{BaseURL: server.URL, HTTP: server.Client(), ClientID: id}
}

func TestCatalogCommandsUseOnlyPublicEndpoints(t *testing.T) {
	server := newStubBackend(t)
	client := newTestClient(t, server)

	titles, err := client.Search(context.Background(), "frieren")
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(titles) != 1 || titles[0].ID != "tmdb:209867" || titles[0].Type != "anime" {
		t.Fatalf("search results wrong: %+v", titles)
	}

	detail, err := client.TitleDetail(context.Background(), "tmdb:209867")
	if err != nil || detail.IMDBID != "tt28015436" {
		t.Fatalf("detail = %+v, %v", detail, err)
	}

	episodes, err := client.Episodes(context.Background(), "tmdb:209867", 1)
	if err != nil || len(episodes) != 2 {
		t.Fatalf("episodes = %+v, %v", episodes, err)
	}
	if episodes[0].Title != "The Journey's End" || episodes[0].DurationS != 1440 {
		t.Fatalf("episode mapping wrong: %+v", episodes[0])
	}
}

func TestSearchRejectsMissingCapability(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/version" {
			_, _ = w.Write([]byte(`{"serverVersion":"1.0.0","protocolVersion":1,"supportedProtocolRange":[1,1],"capabilities":[]}`))
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(server.Close)
	client := newTestClient(t, server)
	if _, err := client.Search(context.Background(), "frieren"); err == nil || !strings.Contains(err.Error(), "catalog.bff.v2") {
		t.Fatalf("search without the catalog capability must fail with guidance: %v", err)
	}
}
