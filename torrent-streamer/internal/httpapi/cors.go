package httpapi

import (
	"net/http"
	"strings"
)

// OriginAllowlist gates CORS on the versioned browser/mobile surfaces
// (/v1/version, /readyz, /v2/catalog/*) with an explicit, configurable
// origin allowlist — never a wildcard. Requests without an Origin header
// (non-browser clients, same-origin calls) are served without CORS headers,
// exactly as before. Requests with an allowed Origin get that origin echoed
// in Access-Control-Allow-Origin; disallowed origins get no CORS headers, so
// browsers refuse to read the response while non-browser tools are unaffected.
type OriginAllowlist struct {
	allowed map[string]bool
}

func NewOriginAllowlist(origins []string) OriginAllowlist {
	allowed := map[string]bool{}
	for _, origin := range origins {
		normalized := strings.ToLower(strings.TrimSpace(origin))
		if normalized == "" || normalized == "*" {
			continue
		}
		allowed[normalized] = true
	}
	return OriginAllowlist{allowed: allowed}
}

func (a OriginAllowlist) Allows(origin string) bool {
	return a.allowed[strings.ToLower(strings.TrimSpace(origin))]
}

const corsAllowedHeaders = "Content-Type, Range, X-Torwatch-Protocol, X-Torwatch-Capability"
const corsAllowedMethods = "GET, HEAD, OPTIONS"

// applyCORS sets the origin-scoped CORS headers for one request and reports
// whether preflight handling should stop the handler chain (OPTIONS).
func (a OriginAllowlist) applyCORS(w http.ResponseWriter, r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		// No Origin header: not a CORS request. Serve without CORS headers.
		return r.Method == http.MethodOptions
	}
	if !a.Allows(origin) {
		// Disallowed origin: no CORS headers. Browsers block the read;
		// the response itself stays truthful for non-browser callers.
		return r.Method == http.MethodOptions
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Vary", "Origin")
	w.Header().Set("Access-Control-Allow-Methods", corsAllowedMethods)
	w.Header().Set("Access-Control-Allow-Headers", corsAllowedHeaders)
	w.Header().Set("Access-Control-Max-Age", "600")
	return r.Method == http.MethodOptions
}

// allowlistCORS wraps a versioned-surface handler with the origin allowlist.
func allowlistCORS(allow OriginAllowlist, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if allow.applyCORS(w, r) {
			// Preflight: headers (if any) are set; no body.
			return
		}
		next(w, r)
	}
}
