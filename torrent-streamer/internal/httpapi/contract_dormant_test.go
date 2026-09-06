package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"torrent-streamer/internal/watch"
)

func newWatchMux(t *testing.T, ensure func(watch.Key) error) (*http.ServeMux, *[]watch.Key) {
	t.Helper()
	opened := &[]watch.Key{}
	mgr := watch.NewManager(20*time.Second, 30*time.Second, func(k watch.Key) error {
		*opened = append(*opened, k)
		if ensure != nil {
			return ensure(k)
		}
		return nil
	}, func(watch.Key) {})
	t.Cleanup(mgr.Shutdown)
	mux := http.NewServeMux()
	mux.HandleFunc("/watch/open", mgr.HandleOpen)
	mux.HandleFunc("/watch/ping", mgr.HandlePing)
	mux.HandleFunc("/watch/close", mgr.HandleClose)
	return mux, opened
}

func TestWatchOpenRouteCapturedShape(t *testing.T) {
	t.Parallel()
	mux, opened := newWatchMux(t, nil)

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet,
		"/watch/open?cat=tv&infoHash=0123456789abcdef0123456789abcdef01234567&fileIndex=3", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("open = %d body=%q", recorder.Code, recorder.Body.String())
	}
	payload := decodeBody(t, recorder)
	leaseID, _ := payload["leaseId"].(string)
	if len(leaseID) != 32 {
		t.Fatalf("leaseId = %q, want 32 hex chars", leaseID)
	}
	if len(*opened) != 1 {
		t.Fatalf("ensure calls = %d", len(*opened))
	}
	key := (*opened)[0]
	if key.Cat != "tv" || key.ID != "0123456789ABCDEF0123456789ABCDEF01234567" || key.FileIndex != 3 {
		t.Fatalf("parsed key = %+v", key)
	}
}

func TestWatchOpenBodyContractAndFileIndexQuirk(t *testing.T) {
	t.Parallel()
	mux, opened := newWatchMux(t, nil)

	body := `{"cat":"anime","infoHash":"0123456789ABCDEF0123456789ABCDEF01234567","fileIndex":7}`
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/watch/open", strings.NewReader(body)))
	if recorder.Code != http.StatusOK {
		t.Fatalf("body open = %d body=%q", recorder.Code, recorder.Body.String())
	}
	key := (*opened)[0]
	if key.Cat != "anime" || key.ID != "0123456789ABCDEF0123456789ABCDEF01234567" {
		t.Fatalf("parsed key = %+v", key)
	}
	if key.FileIndex != -1 {
		t.Fatalf("body fileIndex = %d, want -1 (JSON body fileIndex is parsed but ignored)", key.FileIndex)
	}
}

func TestWatchOpenMagnetKeyExtraction(t *testing.T) {
	t.Parallel()
	mux, opened := newWatchMux(t, nil)

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet,
		"/watch/open?magnet="+url.QueryEscape("magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&tr=udp://x"), nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("magnet open = %d body=%q", recorder.Code, recorder.Body.String())
	}
	if key := (*opened)[0]; key.ID != "0123456789ABCDEF0123456789ABCDEF01234567" {
		t.Fatalf("magnet key = %+v", key)
	}
}

func TestWatchOpenErrorContracts(t *testing.T) {
	t.Parallel()
	mux, _ := newWatchMux(t, func(watch.Key) error { return nil })

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/watch/open", nil))
	if recorder.Code != http.StatusBadRequest || recorder.Body.String() != "bad key\n" {
		t.Fatalf("no id = %d %q", recorder.Code, recorder.Body.String())
	}

	mux, _ = newWatchMux(t, func(watch.Key) error { return errors.New("offline") })
	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet,
		"/watch/open?infoHash=0123456789ABCDEF0123456789ABCDEF01234567", nil))
	if recorder.Code != http.StatusBadGateway ||
		recorder.Body.String() != "ensure failed: offline\n" {
		t.Fatalf("ensure failure = %d %q", recorder.Code, recorder.Body.String())
	}
}

func TestWatchSharedLeaseLifecycle(t *testing.T) {
	t.Parallel()
	mux, _ := newWatchMux(t, func(watch.Key) error { return nil })

	open := func() string {
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet,
			"/watch/open?infoHash=0123456789ABCDEF0123456789ABCDEF01234567", nil))
		if recorder.Code != http.StatusOK {
			t.Fatalf("open = %d body=%q", recorder.Code, recorder.Body.String())
		}
		return decodeBody(t, recorder)["leaseId"].(string)
	}
	first, second := open(), open()
	if first == second {
		t.Fatalf("second lease must be distinct, got %q twice", first)
	}

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/watch/ping?leaseId="+first, nil))
	if recorder.Code != http.StatusNoContent || recorder.Body.String() != "" {
		t.Fatalf("ping first = %d %q", recorder.Code, recorder.Body.String())
	}
	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/watch/ping?leaseId="+second, nil))
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("ping second = %d", recorder.Code)
	}

	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/watch/ping?leaseId=0123456789abcdef0123456789abcdef01", nil))
	if recorder.Code != http.StatusNotFound || recorder.Body.String() != "unknown lease\n" {
		t.Fatalf("unknown ping = %d %q", recorder.Code, recorder.Body.String())
	}
	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/watch/ping", nil))
	if recorder.Code != http.StatusBadRequest || recorder.Body.String() != "missing leaseId\n" {
		t.Fatalf("missing ping = %d %q", recorder.Code, recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/watch/close?leaseId="+first, nil))
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("close = %d", recorder.Code)
	}
	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/watch/close?leaseId=does-not-exist-0000", nil))
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("close unknown = %d (close is always 204)", recorder.Code)
	}
	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/watch/close", nil))
	if recorder.Code != http.StatusBadRequest || recorder.Body.String() != "missing leaseId\n" {
		t.Fatalf("close missing = %d %q", recorder.Code, recorder.Body.String())
	}
	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/watch/close",
		strings.NewReader("leaseId="+second)))
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("sendBeacon close = %d", recorder.Code)
	}
}

func TestWatchManagerOpenContext(t *testing.T) {
	t.Parallel()
	mgr := watch.NewManager(20*time.Second, 30*time.Second, func(watch.Key) error { return nil }, func(watch.Key) {})
	t.Cleanup(mgr.Shutdown)
	lease, err := mgr.Open(context.Background(), watch.Key{Cat: "movie", ID: "0123456789ABCDEF0123456789ABCDEF01234567", FileIndex: -1}, watch.LeaseOptions{})
	if err != nil || len(lease) != 32 {
		t.Fatalf("Open = %q, %v", lease, err)
	}
	if !mgr.Ping(context.Background(), lease) {
		t.Fatal("Ping after Open = false")
	}
	if !mgr.Close(context.Background(), lease) {
		t.Fatal("Close after Open = false")
	}
	if mgr.Ping(context.Background(), lease) {
		t.Fatal("Ping after Close = true")
	}
}

func TestDormantAddPrefetchContracts(t *testing.T) {
	t.Parallel()
	mux := http.NewServeMux()
	RegisterRoutes(mux)

	for _, route := range []string{"/add", "/prefetch"} {
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, route, nil))
		if recorder.Code != http.StatusBadRequest ||
			recorder.Body.String() != "missing magnet/src/infoHash\n" {
			t.Fatalf("%s no src = %d %q", route, recorder.Code, recorder.Body.String())
		}
		recorder = httptest.NewRecorder()
		mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, route+"?infoHash=zzz", nil))
		if recorder.Code != http.StatusBadRequest ||
			recorder.Body.String() != "invalid infoHash\n" {
			t.Fatalf("%s invalid infoHash = %d %q", route, recorder.Code, recorder.Body.String())
		}
	}
}

func TestDormantStatsCapturedShape(t *testing.T) {
	t.Parallel()
	mux := http.NewServeMux()
	RegisterRoutes(mux)

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/stats", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%q", recorder.Code, recorder.Body.String())
	}
	payload := decodeBody(t, recorder)
	for _, key := range []string{"uptimeSeconds", "dataRoot", "totalCacheBytes", "cacheMaxBytes", "evictTTL", "trackersMode", "categories"} {
		if _, ok := payload[key]; !ok {
			t.Fatalf("stats missing %q: %v", key, payload)
		}
	}
}
