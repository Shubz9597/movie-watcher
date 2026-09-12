package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"torrent-streamer/internal/buildinfo"
	"torrent-streamer/internal/catalog"
)

// M1.4.6: the exact Capacitor web origins produced by Capacitor 8 (iOS:
// capacitor://localhost; Android with androidScheme=https: https://localhost)
// must be the ONLY additional mobile origins an operator needs to allowlist.
// Unrelated origins, the opaque null origin, and wildcards stay rejected by
// the same exact-match allowlist â€” this test pins that boundary.
func TestCapacitorOriginsAllowlistContract(t *testing.T) {
	capacitorOrigins := []string{
		"https://torwatch.lan",
		"capacitor://localhost", // iOS Capacitor WebView origin
		"https://localhost",     // Android Capacitor WebView origin (androidScheme=https)
	}
	h := CatalogHandlers{
		Catalog:        catalog.NewService(nil, catalog.Options{}),
		Build:          buildinfo.Info{SupportedProtocolRange: []int{1, 1}},
		AllowedOrigins: capacitorOrigins,
	}
	mux := http.NewServeMux()
	h.Register(mux)

	for _, origin := range capacitorOrigins {
		req := httptest.NewRequest(http.MethodOptions, "/v2/catalog/search", nil)
		req.Header.Set("Origin", origin)
		req.Header.Set("Access-Control-Request-Method", "GET")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != origin {
			t.Fatalf("capacitor origin %q: ACAO = %q", origin, got)
		}
	}

	rejected := map[string]string{
		"null":                           "opaque/null origin",
		"https://evil.example":           "unrelated origin",
		"capacitor://evil":               "scheme lookalike",
		"https://localhost.evil.example": "suffix lookalike",
	}
	for origin, why := range rejected {
		req := httptest.NewRequest(http.MethodOptions, "/v2/catalog/search", nil)
		req.Header.Set("Origin", origin)
		req.Header.Set("Access-Control-Request-Method", "GET")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
			t.Fatalf("%s (%q) must receive NO CORS headers, got %q", why, origin, got)
		}
	}

	// Wildcard can never enter the allowlist (config layer drops it).
	allow := NewOriginAllowlist([]string{"*", strings.ToUpper("capacitor://localhost")})
	if allow.Allows("https://anything.example") {
		t.Fatal("wildcard must stay rejected")
	}
	if !allow.Allows("capacitor://localhost") {
		t.Fatal("allowlist matching is case-insensitive on exact entries")
	}
}
