package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"torrent-streamer/internal/watch"
)

// T051 characterization of the CURRENT /watch/* release semantics, captured
// before the admission/lease-metadata changes: multiple concurrent leases per
// key; resources stopped only after EVERY lease closes or goes stale; close
// does not stop the torrent immediately (quick-reload tolerance).
func TestWatchLeaseReleaseSemanticsCharacterization(t *testing.T) {
	var mu sync.Mutex
	var stopped []watch.Key
	stop := func(k watch.Key) {
		mu.Lock()
		stopped = append(stopped, k)
		mu.Unlock()
	}
	mgr := watch.NewManager(120*time.Millisecond, 40*time.Millisecond, func(watch.Key) error { return nil }, stop)
	t.Cleanup(mgr.Shutdown)

	mux := http.NewServeMux()
	mux.HandleFunc("/watch/open", mgr.HandleOpen)
	mux.HandleFunc("/watch/ping", mgr.HandlePing)
	mux.HandleFunc("/watch/close", mgr.HandleClose)

	open := func() string {
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet,
			"/watch/open?infoHash=ABCDEF0123456789ABCDEF0123456789ABCDEF01", nil))
		if recorder.Code != http.StatusOK {
			t.Fatalf("open = %d %s", recorder.Code, recorder.Body.String())
		}
		return decodeBody(t, recorder)["leaseId"].(string)
	}

	first := open()
	second := open()

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/watch/close?leaseId="+first, nil))
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("close first = %d", recorder.Code)
	}

	// The surviving lease keeps the key alive: ping still succeeds and the
	// reaper must NOT stop the resource while any lease remains.
	deadline := time.Now().Add(300 * time.Millisecond)
	for time.Now().Before(deadline) {
		recorder = httptest.NewRecorder()
		mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/watch/ping?leaseId="+second, nil))
		if recorder.Code != http.StatusNoContent {
			t.Fatalf("surviving lease ping = %d", recorder.Code)
		}
		time.Sleep(20 * time.Millisecond)
	}
	mu.Lock()
	stoppedCount := len(stopped)
	mu.Unlock()
	if stoppedCount != 0 {
		t.Fatalf("resource stopped while a lease was alive: %v", stopped)
	}

	// Closing the last lease does not stop immediately (quick-reload
	// tolerance) — the reaper performs the stop after staleAfter.
	mux.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/watch/close?leaseId="+second, nil))
	deadline = time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		mu.Lock()
		count := len(stopped)
		mu.Unlock()
		if count == 1 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	t.Fatalf("reaper never released the key after the last lease closed: %v", stopped)
}

// T057: capacity admission on /watch/open. Distinct-key counting; denial
// applies only to a NEW key with the contracted capacity_exceeded body;
// same-key sharing always succeeds; existing leases are never terminated.
func TestWatchOpenCapacityExceededContract(t *testing.T) {
	mgr := watch.NewManager(time.Second, time.Second, func(watch.Key) error { return nil }, func(watch.Key) {})
	mgr.SetMaxActiveTitles(1)
	t.Cleanup(mgr.Shutdown)

	mux := http.NewServeMux()
	mux.HandleFunc("/watch/open", mgr.HandleOpen)

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet,
		"/watch/open?infoHash=AAADEF0123456789ABCDEF0123456789ABCDEF01", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("first distinct key = %d %s", recorder.Code, recorder.Body.String())
	}
	first := decodeBody(t, recorder)
	if first["activeLeases"] != float64(1) {
		t.Fatalf("activeLeases = %v", first["activeLeases"])
	}

	// A SECOND distinct key is denied with the contracted body.
	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet,
		"/watch/open?infoHash=BBBDEF0123456789ABCDEF0123456789ABCDEF02", nil))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("second distinct key = %d %s", recorder.Code, recorder.Body.String())
	}
	payload := decodeBody(t, recorder)
	errBody, _ := payload["error"].(map[string]any)
	if errBody == nil || errBody["code"] != "capacity_exceeded" {
		t.Fatalf("error payload = %v", payload)
	}
	if _, ok := errBody["retryAfterSeconds"]; !ok {
		t.Fatalf("retryAfterSeconds missing: %v", errBody)
	}

	// Same-key sharing still succeeds and existing leases are untouched.
	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet,
		"/watch/open?infoHash=AAADEF0123456789ABCDEF0123456789ABCDEF01&clientId=11111111-1111-4111-8111-111111111111", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("same-key share denied: %d %s", recorder.Code, recorder.Body.String())
	}
	shared := decodeBody(t, recorder)
	if shared["activeLeases"] != float64(2) {
		t.Fatalf("activeLeases after share = %v", shared["activeLeases"])
	}
}

// T055: clientId format validation (opaque, format/length only — FR-013).
func TestWatchOpenClientIdValidation(t *testing.T) {
	mgr := watch.NewManager(time.Second, time.Second, func(watch.Key) error { return nil }, func(watch.Key) {})
	t.Cleanup(mgr.Shutdown)
	mux := http.NewServeMux()
	mux.HandleFunc("/watch/open", mgr.HandleOpen)

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet,
		"/watch/open?infoHash=ABCDEF0123456789ABCDEF0123456789ABCDEF03&clientId=not-a-uuid", nil))
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "invalid clientId") {
		t.Fatalf("invalid clientId = %d %s", recorder.Code, recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet,
		"/watch/open?infoHash=ABCDEF0123456789ABCDEF0123456789ABCDEF03&clientId=ABCDEF01-2345-4678-9ABC-DEF012345678&sessionId=abc123", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("valid clientId+sessionId = %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestWatchStaleLeaseReapingCharacterization(t *testing.T) {
	var mu sync.Mutex
	var stopped []watch.Key
	stop := func(k watch.Key) {
		mu.Lock()
		stopped = append(stopped, k)
		mu.Unlock()
	}
	mgr := watch.NewManager(80*time.Millisecond, 30*time.Millisecond, func(watch.Key) error { return nil }, stop)
	t.Cleanup(mgr.Shutdown)

	mux := http.NewServeMux()
	mux.HandleFunc("/watch/open", mgr.HandleOpen)
	mux.HandleFunc("/watch/ping", mgr.HandlePing)

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet,
		"/watch/open?infoHash=ABCDEF0123456789ABCDEF0123456789ABCDEF02", nil))
	lease := decodeBody(t, recorder)["leaseId"].(string)

	// Ping refresh keeps the lease alive past the stale window.
	deadline := time.Now().Add(200 * time.Millisecond)
	for time.Now().Before(deadline) {
		recorder = httptest.NewRecorder()
		mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/watch/ping?leaseId="+lease, nil))
		if recorder.Code != http.StatusNoContent {
			t.Fatalf("pinged lease reaped prematurely: ping = %d", recorder.Code)
		}
		time.Sleep(25 * time.Millisecond)
	}

	// Stop pinging: the lease goes stale and the key is reaped.
	deadline = time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		mu.Lock()
		count := len(stopped)
		mu.Unlock()
		if count == 1 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	t.Fatalf("stale lease was never reaped: %v", stopped)
}
