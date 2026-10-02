package subtitles

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// Some OpenSubtitles consumers get 403 "You cannot consume this service"
// for parent-id/type=episode searches while title searches work: the
// episode search must fall back to a title query instead of failing.
func TestEpisodeSearchFallsBackToTitleOn403(t *testing.T) {
	var mu sync.Mutex
	var queries []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		queries = append(queries, r.URL.RawQuery)
		mu.Unlock()
		q := r.URL.Query()
		if q.Get("parent_tmdb_id") != "" || q.Get("type") == "episode" || q.Get("order_by") != "" {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"message":"You cannot consume this service"}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"total_count":1,"data":[{"attributes":{"language":"en","release":"Severance.S01E01.1080p",
			"download_count":10,"files":[{"file_id":42,"file_name":"Severance.S01E01.srt"}]}}]}`))
	}))
	defer server.Close()
	previous := openSubAPI
	openSubAPI = server.URL
	defer func() { openSubAPI = previous }()

	results, err := FetchFromOpenSub(context.Background(), SearchQuery{
		TMDBID: "95396", Title: "Severance FallbackTest", Season: 1, Episode: 1, Langs: []string{"en"},
	}, "key")
	if err != nil {
		t.Fatalf("fallback search failed: %v", err)
	}
	if len(results) != 1 || results[0].ID != "42" {
		t.Fatalf("results = %#v", results)
	}
	last := queries[len(queries)-1]
	if len(queries) < 2 || !strings.Contains(last, "query=severance+fallbacktest") ||
		strings.Contains(last, "type=") || strings.Contains(last, "order_by") || strings.Contains(last, "parent_") {
		t.Fatalf("expected a title retry without type=episode, got %v", queries)
	}
}
