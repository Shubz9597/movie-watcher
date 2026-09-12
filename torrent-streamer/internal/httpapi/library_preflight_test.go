package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"torrent-streamer/internal/buildinfo"
	"torrent-streamer/internal/library"
)

// Regression (desktop-staging two-client validation): the household-library
// PUT surface must be preflightable from allowlisted browser/mobile origins.
// The preflight previously advertised only GET/HEAD/OPTIONS, so every
// cross-origin library write failed in real browsers.
func TestLibraryPutPreflightAllowsPUTFromAllowlistedOrigin(t *testing.T) {
	store := &library.Store{}
	mux := http.NewServeMux()
	LibraryHandlers{
		Library:        store,
		Build:          buildinfo.New(buildinfo.Options{ServerVersion: "test", Capabilities: []string{library.Capability}}),
		AllowedOrigins: []string{"http://127.0.0.1:4174"},
	}.Register(mux)

	req := httptest.NewRequest(http.MethodOptions, "/v2/library/tmdb:movie:1/watch-later", nil)
	req.Header.Set("Origin", "http://127.0.0.1:4174")
	req.Header.Set("Access-Control-Request-Method", "PUT")
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusOK {
		t.Fatalf("preflight status = %d, want 200", recorder.Code)
	}
	if got := recorder.Header().Get("Access-Control-Allow-Origin"); got != "http://127.0.0.1:4174" {
		t.Fatalf("preflight allow-origin = %q", got)
	}
	methods := recorder.Header().Get("Access-Control-Allow-Methods")
	if !strings.Contains(methods, "PUT") {
		t.Fatalf("preflight methods %q must include PUT", methods)
	}
}

// A disallowed origin gets no CORS headers on the write preflight either.
func TestLibraryPutPreflightRejectsUnknownOrigin(t *testing.T) {
	store := &library.Store{}
	mux := http.NewServeMux()
	LibraryHandlers{
		Library: store,
		Build:   buildinfo.New(buildinfo.Options{ServerVersion: "test"}),
	}.Register(mux)

	req := httptest.NewRequest(http.MethodOptions, "/v2/library/tmdb:movie:1/watch-later", nil)
	req.Header.Set("Origin", "https://evil.example")
	req.Header.Set("Access-Control-Request-Method", "PUT")
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, req)

	if recorder.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("disallowed origin must not receive CORS headers")
	}
}
