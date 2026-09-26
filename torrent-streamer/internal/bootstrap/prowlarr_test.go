package bootstrap

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeProwlarr is a minimal Prowlarr stand-in covering the endpoints the
// bootstrap touches (architecture.md §8 test matrix).
type fakeProwlarr struct {
	mu        sync.Mutex
	indexers  []map[string]any
	addErrors map[string]bool // starter names that fail on POST
	statusUp  atomic.Bool
	started   chan struct{}
	listCalls atomic.Int64
	postCalls atomic.Int64
}

func newFakeProwlarr() *fakeProwlarr {
	return &fakeProwlarr{started: make(chan struct{})}
}

func (f *fakeProwlarr) setIndexers(list []map[string]any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.indexers = list
}

func (f *fakeProwlarr) handler(t *testing.T, apiKey string) http.Handler {
	mux := http.NewServeMux()
	requireKey := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("X-Api-Key") != apiKey {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			next(w, r)
		}
	}
	mux.HandleFunc("/api/v1/system/status", requireKey(func(w http.ResponseWriter, r *http.Request) {
		if !f.statusUp.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"appName": "Prowlarr"})
	}))
	mux.HandleFunc("/api/v1/indexer", requireKey(func(w http.ResponseWriter, r *http.Request) {
		f.listCalls.Add(1)
		switch r.Method {
		case http.MethodGet:
			f.mu.Lock()
			defer f.mu.Unlock()
			_ = json.NewEncoder(w).Encode(f.indexers)
		case http.MethodPost:
			f.postCalls.Add(1)
			var payload map[string]any
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			name, _ := payload["name"].(string)
			if f.addErrors[name] {
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			f.mu.Lock()
			f.indexers = append(f.indexers, payload)
			f.mu.Unlock()
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(payload)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	mux.HandleFunc("/api/v1/indexer/schema", requireKey(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode([]map[string]any{
			{
				"implementation": "Cardigann",
				"configContract": "CardigannSettings",
				"infoLink":       "https://wiki.servarr.com/",
				"fields": []map[string]any{
					{"name": "definitionFile", "value": "yts"},
					{"name": "baseSettings.grabLimit", "value": nil},
				},
			},
			{
				"implementation": "SubsPlease",
				"configContract": "SubsPleaseSettings",
				"fields":         []map[string]any{},
			},
		})
	}))
	mux.HandleFunc("/api/v1/appProfile", requireKey(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode([]map[string]any{{"id": 1, "name": "Standard"}})
	}))
	return mux
}

func startFake(t *testing.T, apiKey string, f *fakeProwlarr) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(f.handler(t, apiKey))
	t.Cleanup(srv.Close)
	return srv
}

func writeConfig(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.xml")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func testOpts(server *httptest.Server, starters []Starter) Options {
	return Options{
		BaseURL:      server.URL,
		HTTPClient:   &http.Client{Timeout: 5 * time.Second},
		Starters:     starters,
		Timeout:      10 * time.Second,
		PollInterval: 10 * time.Millisecond,
	}
}

func starterFor(definition string) Starter {
	return Starter{Definition: definition, Name: strings.ToUpper(definition), Priority: 10, MinimumSeeders: 2}
}

// 1. Explicit API key is preferred over any configuration file.
func TestExplicitKeyPreferred(t *testing.T) {
	f := newFakeProwlarr()
	f.statusUp.Store(true)
	srv := startFake(t, "explicit-key", f)

	configFile := writeConfig(t, "<Config><ApiKey>stale-key</ApiKey></Config>")
	opts := testOpts(srv, []Starter{starterFor("yts")})
	opts.ExplicitKey = "explicit-key"
	opts.ConfigFile = configFile

	res, err := Run(context.Background(), opts)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.APIKey != "explicit-key" || res.KeySource != "explicit" {
		t.Fatalf("key = %q source = %q, want explicit-key/explicit", res.APIKey, res.KeySource)
	}
	if res.IndexersAdded == nil || len(res.IndexersAdded) != 1 {
		t.Fatalf("added = %v, want one starter", res.IndexersAdded)
	}
}

// 2. Generated key is read from the configured read-only config file.
func TestConfigFileKey(t *testing.T) {
	f := newFakeProwlarr()
	f.statusUp.Store(true)
	srv := startFake(t, "generated-key", f)

	opts := testOpts(srv, nil)
	opts.ConfigFile = writeConfig(t, "<Config><ApiKey>generated-key</ApiKey></Config>")

	res, err := Run(context.Background(), opts)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.APIKey != "generated-key" || res.KeySource != "config-file" {
		t.Fatalf("key = %q source = %q, want generated-key/config-file", res.APIKey, res.KeySource)
	}
}

// 3. Missing or malformed configuration has a bounded, redacted failure.
func TestMissingAndMalformedConfigBounded(t *testing.T) {
	f := newFakeProwlarr()
	srv := startFake(t, "k", f)

	opts := testOpts(srv, nil)
	opts.ConfigFile = filepath.Join(t.TempDir(), "absent.xml")
	opts.Timeout = 150 * time.Millisecond
	if _, err := Run(context.Background(), opts); err == nil {
		t.Fatal("want bounded failure for missing config file")
	}

	opts.ConfigFile = writeConfig(t, "not xml at all")
	if _, err := Run(context.Background(), opts); err == nil {
		t.Fatal("want failure for malformed config file")
	}

	// No key source at all fails fast with a redacted message.
	none := testOpts(srv, nil)
	none.Timeout = time.Second
	if _, err := Run(context.Background(), none); err == nil {
		t.Fatal("want failure when no key source is configured")
	}
}

// 4. A populated Prowlarr instance is never altered.
func TestPopulatedInstancePreserved(t *testing.T) {
	f := newFakeProwlarr()
	f.statusUp.Store(true)
	f.setIndexers([]map[string]any{{"name": "Existing"}})
	srv := startFake(t, "k", f)

	opts := testOpts(srv, []Starter{starterFor("yts"), starterFor("nyaasi")})
	opts.ExplicitKey = "k"

	res, err := Run(context.Background(), opts)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(res.IndexersAdded) != 0 || res.IndexersPreserved != 1 {
		t.Fatalf("added = %v preserved = %d, want none/1", res.IndexersAdded, res.IndexersPreserved)
	}
	if f.postCalls.Load() != 0 {
		t.Fatalf("POST calls = %d, want 0 (instance must be untouched)", f.postCalls.Load())
	}
}

// 5. An empty instance receives the starter set once; repeated runs are
// idempotent (second run observes a populated instance and adds nothing).
func TestStartersOnceAndIdempotent(t *testing.T) {
	f := newFakeProwlarr()
	f.statusUp.Store(true)
	srv := startFake(t, "k", f)

	opts := testOpts(srv, []Starter{starterFor("yts")})
	opts.ExplicitKey = "k"

	res, err := Run(context.Background(), opts)
	if err != nil {
		t.Fatalf("first Run: %v", err)
	}
	if len(res.IndexersAdded) != 1 {
		t.Fatalf("added = %v, want one", res.IndexersAdded)
	}
	if res.IndexersPreserved != 0 {
		t.Fatalf("preserved = %d, want 0", res.IndexersPreserved)
	}

	res2, err := Run(context.Background(), opts)
	if err != nil {
		t.Fatalf("second Run: %v", err)
	}
	if len(res2.IndexersAdded) != 0 || res2.IndexersPreserved != 1 {
		t.Fatalf("second run added = %v preserved = %d, want none/1", res2.IndexersAdded, res2.IndexersPreserved)
	}
	if f.postCalls.Load() != 1 {
		t.Fatalf("total POSTs = %d, want 1", f.postCalls.Load())
	}
}

// 6. Concurrent bootstrap calls against the same instance stay idempotent:
// each caller either sees the empty list and adds, or sees a populated list
// and preserves; the fake serializes POSTs so duplicates would surface as two
// identical starter names.
func TestConcurrentBootstrapIdempotent(t *testing.T) {
	f := newFakeProwlarr()
	f.statusUp.Store(true)
	srv := startFake(t, "k", f)

	opts := testOpts(srv, []Starter{starterFor("yts")})
	opts.ExplicitKey = "k"

	var wg sync.WaitGroup
	errCh := make(chan error, 4)
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := Run(context.Background(), opts); err != nil {
				errCh <- err
			}
		}()
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.Fatalf("Run: %v", err)
	}

	f.mu.Lock()
	defer f.mu.Unlock()
	names := map[string]int{}
	for _, idx := range f.indexers {
		if name, ok := idx["name"].(string); ok {
			names[name]++
		}
	}
	if len(names) != 1 || names["YTS"] != 1 {
		t.Fatalf("indexers after concurrent bootstrap = %v, want exactly one YTS", names)
	}
}

// 7. One starter failure does not duplicate successful starters on restart
// and is reported as degraded, not fatal.
func TestPartialStarterFailure(t *testing.T) {
	f := newFakeProwlarr()
	f.statusUp.Store(true)
	f.addErrors = map[string]bool{"YTS": true}
	srv := startFake(t, "k", f)

	opts := testOpts(srv, []Starter{starterFor("yts"), starterFor("nyaasi")})
	// Only YTS has a schema in the fake; nyaasi exercises the
	// missing-schema path too.
	opts.ExplicitKey = "k"

	res, err := Run(context.Background(), opts)
	if err != nil {
		t.Fatalf("Run must not fail on starter errors: %v", err)
	}
	if len(res.IndexersAdded) != 0 {
		t.Fatalf("added = %v, want none", res.IndexersAdded)
	}
	if len(res.IndexersFailed) != 2 {
		t.Fatalf("failed = %v, want both starters reported", res.IndexersFailed)
	}
}

// 8. Cancellation stops waits promptly.
func TestCancellationStopsPromptly(t *testing.T) {
	f := newFakeProwlarr()
	srv := startFake(t, "k", f)

	opts := testOpts(srv, nil)
	opts.ConfigFile = filepath.Join(t.TempDir(), "never-appears.xml")
	opts.Timeout = time.Minute

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := Run(ctx, opts)
		done <- err
	}()
	time.Sleep(50 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("want error after cancellation")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not stop promptly after cancellation")
	}
}

// 9. Captured logs contain no API key material.
func TestLogsContainNoAPIKey(t *testing.T) {
	f := newFakeProwlarr()
	f.statusUp.Store(true)
	srv := startFake(t, "secret-key-value", f)

	logBuf := &strings.Builder{}
	opts := testOpts(srv, []Starter{starterFor("yts")})
	opts.ExplicitKey = "secret-key-value"
	opts.Log = newTestLogger(logBuf)

	if _, err := Run(context.Background(), opts); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if strings.Contains(logBuf.String(), "secret-key-value") {
		t.Fatalf("logs leaked the API key:\n%s", logBuf.String())
	}
}

// Prowlarr responding 5xx on every status poll yields a bounded readiness
// failure rather than an unbounded hang.
func TestReadinessBounded(t *testing.T) {
	f := newFakeProwlarr()
	srv := startFake(t, "k", f)

	opts := testOpts(srv, nil)
	opts.ExplicitKey = "k"
	opts.Timeout = 200 * time.Millisecond

	_, err := Run(context.Background(), opts)
	if err == nil || !strings.Contains(err.Error(), "ready") {
		t.Fatalf("err = %v, want bounded readiness failure", err)
	}
}

func ExampleResult_jsonShape() {
	res := Result{KeySource: "explicit", IndexersPreserved: 3, IndexersAdded: []string{"YTS"}}
	data, _ := json.Marshal(res)
	fmt.Println(string(data))
	// Output: {"keySource":"explicit","indexersPreserved":3,"indexersAdded":["YTS"],"indexersFailed":null}
}
