package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"torrent-streamer/internal/buildinfo"
	"torrent-streamer/internal/catalog"
)

// T049 contract tests (contracts/protocol-negotiation.md): explicit,
// sanitized machine-readable errors for unsupported protocols/capabilities,
// and proof that differing application versions alone are never rejected
// when protocol ranges overlap (FR-011 rule 5).
func TestNegotiationUnsupportedProtocolIncludesServerRange(t *testing.T) {
	build := buildinfo.New(buildinfo.Options{ServerVersion: "2.0.0-test", Capabilities: []string{"catalog.bff.v2"}})
	handlers := CatalogHandlers{
		Catalog: catalog.NewService([]catalog.Provider{}, catalog.Options{}),
		Build:   build,
	}
	mux := http.NewServeMux()
	handlers.Register(mux)

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/v2/catalog/search?q=x", nil)
	request.Header.Set("X-Torwatch-Protocol", "7")
	mux.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"code":"unsupported_protocol"`) {
		t.Fatalf("error code missing: %s", recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"supportedProtocolRange":[1,1]`) {
		t.Fatalf("server range missing from the error payload: %s", recorder.Body.String())
	}
}

func TestNegotiationUnsupportedCapabilityIncludesCapabilityList(t *testing.T) {
	build := buildinfo.New(buildinfo.Options{ServerVersion: "2.0.0-test", Capabilities: []string{"catalog.bff.v2"}})
	handlers := CatalogHandlers{
		Catalog: catalog.NewService([]catalog.Provider{}, catalog.Options{}),
		Build:   build,
	}
	mux := http.NewServeMux()
	handlers.Register(mux)

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/v2/catalog/search?q=x", nil)
	request.Header.Set("X-Torwatch-Capability", "leases.shared")
	mux.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"code":"unsupported_capability"`) {
		t.Fatalf("error code missing: %s", recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"capabilities":["catalog.bff.v2"]`) {
		t.Fatalf("advertised capability list missing: %s", recorder.Body.String())
	}
}

func TestNegotiationNeverRejectsDifferingApplicationVersions(t *testing.T) {
	build := buildinfo.New(buildinfo.Options{ServerVersion: "2.0.0-test", Capabilities: []string{"catalog.bff.v2"}})
	handlers := CatalogHandlers{
		Catalog: catalog.NewService([]catalog.Provider{
			&fakeCatalogProvider{name: "stub", searchFn: func(ctx context.Context, query catalog.SearchQuery) ([]catalog.Title, error) {
				return []catalog.Title{{ID: "tmdb:1", Type: catalog.TypeMovie, Title: "Ok", ProviderIDs: map[string]string{"tmdb": "1"}, MergedFrom: []string{"tmdb"}}}, nil
			}},
		}, catalog.Options{ProviderTimeout: 50 * time.Millisecond}),
		Build: build,
	}
	mux := http.NewServeMux()
	handlers.Register(mux)

	for _, appVersion := range []string{"0.0.1-ancient", "99.0.0-future", "not-a-version"} {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodGet, "/v2/catalog/search?q=x", nil)
		request.Header.Set("X-Torwatch-App-Version", appVersion)
		request.Header.Set("X-Torwatch-Protocol", "1")
		mux.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusOK {
			t.Fatalf("app version %q must never be rejected when protocol ranges overlap: status %d body=%s",
				appVersion, recorder.Code, recorder.Body.String())
		}
	}
}
