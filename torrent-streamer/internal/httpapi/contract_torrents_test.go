package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"torrent-streamer/internal/imdb"
	"torrent-streamer/internal/search"
)

type fakeIMDb struct {
	rating imdb.Rating
	err    error
}

func (f fakeIMDb) Rating(context.Context, string) (imdb.Rating, error) {
	return f.rating, f.err
}

func newProwlarrStub(t *testing.T, releases string) *search.Service {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/v1/search") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(releases))
	}))
	t.Cleanup(server.Close)
	service, err := search.NewService(server.URL, "test-key", server.Client())
	if err != nil {
		t.Fatalf("search.NewService: %v", err)
	}
	return service
}

func postJSON(handler http.HandlerFunc, path, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	recorder := httptest.NewRecorder()
	handler(recorder, request)
	return recorder
}

func decodeBody(t *testing.T, recorder *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var payload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response body %q: %v", recorder.Body.String(), err)
	}
	return payload
}

func TestTorrentSearchRouteCapturedShape(t *testing.T) {
	t.Parallel()
	const releases = `[
		{"title":"Show S01E05","indexer":"IdxA","protocol":"torrent","size":1000,"seeders":50,"leechers":1,"magnetUrl":"magnet:?xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567","infoHash":"0123456789ABCDEF0123456789ABCDEF01234567","publishDate":"2026-01-01"},
		{"title":"Show S01E05 repack","indexer":"IdxB","protocol":"torrent","size":900,"seeders":10,"leechers":2,"magnetUrl":"magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF01","infoHash":"ABCDEF0123456789ABCDEF0123456789ABCDEF01"}
	]`
	service := newProwlarrStub(t, releases)
	recorder := postJSON(TorrentSearchHandlers{Service: service}.handleSearch,
		"/v1/torrents/search", `{"kind":"movie","title":"Show","year":2026}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Content-Type"); !strings.Contains(got, "application/json") {
		t.Fatalf("content type = %q", got)
	}
	payload := decodeBody(t, recorder)
	query, ok := payload["query"].(map[string]any)
	if !ok || query["kind"] != "movie" || query["title"] != "Show" {
		t.Fatalf("query echo missing/mismatched: %v", payload["query"])
	}
	results, ok := payload["results"].([]any)
	if !ok || len(results) != 2 || payload["total"] != float64(2) {
		t.Fatalf("results/total mismatch: total=%v results=%v", payload["total"], payload["results"])
	}
	first, _ := results[0].(map[string]any)
	if first["title"] != "Show S01E05" {
		t.Fatalf("results not seeder-ordered: %v", results)
	}
	for _, key := range []string{"title", "indexer", "size", "seeders", "leechers", "magnetUri", "infoHash", "publishDate"} {
		if _, ok := first[key]; !ok {
			t.Fatalf("result missing %q: %v", key, first)
		}
	}
	if ih, _ := first["infoHash"].(string); ih != "0123456789ABCDEF0123456789ABCDEF01234567" {
		t.Fatalf("infoHash not uppercase-normalized: %v", first["infoHash"])
	}
}

func TestTorrentSearchRouteCapturesSourceIdOpaque(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		releases := fmt.Sprintf(
			`[{"title":"Movie 2026","indexer":"IdxC","protocol":"torrent","size":2000,"seeders":7,"downloadUrl":"http://%s/download/1"}]`,
			r.Host)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(releases))
	}))
	t.Cleanup(server.Close)
	service, err := search.NewService(server.URL, "test-key", server.Client())
	if err != nil {
		t.Fatalf("search.NewService: %v", err)
	}
	recorder := postJSON(TorrentSearchHandlers{Service: service}.handleSearch,
		"/v1/torrents/search", `{"kind":"movie","title":"Movie"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	results := decodeBody(t, recorder)["results"].([]any)
	first, _ := results[0].(map[string]any)
	sourceID, _ := first["sourceId"].(string)
	if len(sourceID) != 32 {
		t.Fatalf("sourceId = %q, want opaque 32-char id", sourceID)
	}
	if _, hasMagnet := first["magnetUri"]; hasMagnet {
		t.Fatalf("downloadUrl-only release must not expose magnet: %v", first)
	}
}

func TestTorrentSearchRouteValidationContract(t *testing.T) {
	t.Parallel()
	service := newProwlarrStub(t, `[]`)
	handler := TorrentSearchHandlers{Service: service}.handleSearch

	if got := postJSON(handler, "/v1/torrents/search", `{"kind":"movie","title":"x","bogus":1}`).Code; got != http.StatusBadRequest {
		t.Fatalf("unknown field status = %d, want 400", got)
	}
	if got := postJSON(handler, "/v1/torrents/search", `{"kind":"movie"}`).Code; got != http.StatusBadRequest {
		t.Fatalf("missing title status = %d, want 400", got)
	}
	if recorder := postJSON(handler, "/v1/torrents/search", `{"title":"x"}`); recorder.Code != http.StatusBadRequest ||
		recorder.Body.String() != "{\"error\":\"title and a valid kind are required\"}\n" {
		t.Fatalf("invalid kind = %d %q", recorder.Code, recorder.Body.String())
	}
	if recorder := postJSON(handler, "/v1/torrents/search", `{"kind":"movie","title":"x"} trailing`); recorder.Code != http.StatusBadRequest ||
		recorder.Body.String() != "{\"error\":\"request body must contain one JSON object\"}\n" {
		t.Fatalf("trailing content = %d %q", recorder.Code, recorder.Body.String())
	}
	recorder := httptest.NewRecorder()
	handler(recorder, httptest.NewRequest(http.MethodGet, "/v1/torrents/search", nil))
	if recorder.Code != http.StatusMethodNotAllowed ||
		recorder.Body.String() != "{\"error\":\"method not allowed\"}\n" {
		t.Fatalf("GET /v1/torrents/search = %d %q", recorder.Code, recorder.Body.String())
	}
	recorder = httptest.NewRecorder()
	TorrentSearchHandlers{}.handleSearch(recorder, httptest.NewRequest(http.MethodPost, "/v1/torrents/search", strings.NewReader(`{"kind":"movie","title":"x"}`)))
	if recorder.Code != http.StatusServiceUnavailable ||
		recorder.Body.String() != "{\"error\":\"torrent search is not configured\"}\n" {
		t.Fatalf("nil service = %d %q", recorder.Code, recorder.Body.String())
	}
}

func TestTorrentResolveRouteContract(t *testing.T) {
	t.Parallel()
	service := newProwlarrStub(t, `[]`)
	handler := TorrentSearchHandlers{Service: service}.handleResolve

	recorder := postJSON(handler, "/v1/torrents/resolve",
		`{"magnetUri":"magnet:?xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("magnet resolve status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	payload := decodeBody(t, recorder)
	if payload["infoHash"] != "0123456789ABCDEF0123456789ABCDEF01234567" {
		t.Fatalf("magnet resolve payload = %v", payload)
	}

	recorder = postJSON(handler, "/v1/torrents/resolve", `{"infoHash":"0123456789abcdef0123456789abcdef01234567"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("infoHash resolve status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	payload = decodeBody(t, recorder)
	if payload["magnetUri"] != "magnet:?xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567" {
		t.Fatalf("infoHash resolve payload = %v", payload)
	}

	recorder = postJSON(handler, "/v1/torrents/resolve", `{"sourceId":"deadbeef"}`)
	if recorder.Code != http.StatusBadGateway ||
		recorder.Body.String() != "{\"error\":\"source expired; refresh search results and try again\"}\n" {
		t.Fatalf("unknown sourceId = %d %q", recorder.Code, recorder.Body.String())
	}
	recorder = postJSON(handler, "/v1/torrents/resolve", `{}`)
	if recorder.Code != http.StatusBadGateway ||
		recorder.Body.String() != "{\"error\":\"source id, magnet uri, or info hash is required\"}\n" {
		t.Fatalf("empty resolve = %d %q", recorder.Code, recorder.Body.String())
	}
	recorder = httptest.NewRecorder()
	handler(recorder, httptest.NewRequest(http.MethodGet, "/v1/torrents/resolve", nil))
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET resolve = %d", recorder.Code)
	}
}

func TestIMDbRatingsRouteContract(t *testing.T) {
	t.Parallel()
	mux := http.NewServeMux()
	IMDbRatingHandlers{Ratings: fakeIMDb{rating: imdb.Rating{IMDbID: "tt1234567", Rating: 7.5, Votes: 999}}}.Register(mux)

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v1/imdb/ratings/tt1234567", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	payload := decodeBody(t, recorder)
	if payload["imdbId"] != "tt1234567" || payload["rating"] != 7.5 || payload["votes"] != float64(999) {
		t.Fatalf("rating payload = %v", payload)
	}

	mux = http.NewServeMux()
	IMDbRatingHandlers{Ratings: fakeIMDb{err: imdb.ErrRatingNotFound}}.Register(mux)
	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v1/imdb/ratings/tt0000000", nil))
	if recorder.Code != http.StatusNotFound ||
		recorder.Body.String() != "{\"error\":\"IMDb rating not found\"}\n" {
		t.Fatalf("not found = %d %q", recorder.Code, recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v1/imdb/ratings/nm123", nil))
	if recorder.Code != http.StatusBadRequest ||
		recorder.Body.String() != "{\"error\":\"invalid IMDb id\"}\n" {
		t.Fatalf("invalid id = %d %q", recorder.Code, recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/v1/imdb/ratings/tt1234567", nil))
	if recorder.Code != http.StatusMethodNotAllowed || recorder.Body.String() != "" {
		t.Fatalf("POST rating = %d %q", recorder.Code, recorder.Body.String())
	}
}
