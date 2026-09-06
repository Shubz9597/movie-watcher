package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"torrent-streamer/internal/buildinfo"
)

func newSystemTestMux(postgresErr, prowlarrErr error) (*http.ServeMux, *int) {
	postgresCalls := 0
	build := buildinfo.New(buildinfo.Options{ServerVersion: "2.0.0-test"})
	build.Capabilities = []string{}
	handlers := SystemHandlers{
		Build: build,
		Postgres: func(ctx context.Context) error {
			postgresCalls++
			return postgresErr
		},
		Prowlarr: func(ctx context.Context) error {
			return prowlarrErr
		},
	}
	mux := http.NewServeMux()
	handlers.Register(mux)
	return mux, &postgresCalls
}

func TestReadyzContractAllComponentsReady(t *testing.T) {
	mux, calls := newSystemTestMux(nil, nil)
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/readyz", nil))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	var payload struct {
		Status     string            `json:"status"`
		Components map[string]string `json:"components"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode %q: %v", recorder.Body.String(), err)
	}
	if payload.Status != "ok" || payload.Components["postgres"] != "ok" || payload.Components["prowlarr"] != "ok" {
		t.Fatalf("readyz payload = %s", recorder.Body.String())
	}
	if *calls != 1 {
		t.Fatalf("postgres check calls = %d, want 1", *calls)
	}
}

func TestReadyzReturns503WhenPostgresUnavailable(t *testing.T) {
	mux, _ := newSystemTestMux(errors.New("connection refused (details suppressed)"), nil)
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/readyz", nil))

	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	var payload struct {
		Status     string            `json:"status"`
		Components map[string]string `json:"components"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode %q: %v", recorder.Body.String(), err)
	}
	if payload.Status != "unavailable" || payload.Components["postgres"] != "unavailable" {
		t.Fatalf("readyz payload = %s", recorder.Body.String())
	}
	if strings.Contains(recorder.Body.String(), "connection refused") {
		t.Fatal("readiness must report non-secret status only, never error details")
	}
}

func TestReadyzKeepsServingWhenProwlarrDegraded(t *testing.T) {
	mux, _ := newSystemTestMux(nil, errors.New("prowlarr unreachable"))
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/readyz", nil))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"prowlarr":"degraded"`) {
		t.Fatalf("prowlarr degradation not reported: %s", recorder.Body.String())
	}
}

func TestReadyzMethodContract(t *testing.T) {
	mux, _ := newSystemTestMux(nil, nil)
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/readyz", nil))
	if recorder.Code != http.StatusMethodNotAllowed || recorder.Header().Get("Allow") != http.MethodGet {
		t.Fatalf("POST /readyz = %d allow=%q", recorder.Code, recorder.Header().Get("Allow"))
	}
}

func TestVersionEndpointContract(t *testing.T) {
	mux, _ := newSystemTestMux(nil, nil)
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v1/version", nil))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Content-Type"); !strings.Contains(got, "application/json") {
		t.Fatalf("content type = %q", got)
	}
	payload := decodeBody(t, recorder)
	for _, key := range []string{
		"serverVersion", "revision", "builtAt", "protocolVersion",
		"supportedProtocolRange", "goVersion", "os", "arch", "capabilities",
	} {
		if _, ok := payload[key]; !ok {
			t.Fatalf("version payload missing %q: %s", key, recorder.Body.String())
		}
	}
	if payload["protocolVersion"] != float64(1) {
		t.Fatalf("protocolVersion = %v", payload["protocolVersion"])
	}
	if rng, ok := payload["supportedProtocolRange"].([]any); !ok || len(rng) != 2 || rng[0] != float64(1) || rng[1] != float64(1) {
		t.Fatalf("supportedProtocolRange = %v", payload["supportedProtocolRange"])
	}
	if caps, ok := payload["capabilities"].([]any); !ok || len(caps) != 0 {
		t.Fatalf("capabilities must be empty until implemented: %v", payload["capabilities"])
	}
	if payload["serverVersion"] != "2.0.0-test" {
		t.Fatalf("serverVersion = %v", payload["serverVersion"])
	}

	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/v1/version", nil))
	if recorder.Code != http.StatusMethodNotAllowed || recorder.Header().Get("Allow") != http.MethodGet {
		t.Fatalf("POST /v1/version = %d", recorder.Code)
	}
}
