package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"torrent-streamer/internal/buildinfo"
)

// ComponentCheck probes one backing dependency. Implementations return an
// error when the component cannot serve traffic; error details are never
// surfaced to clients (FR-012: readiness reports non-secret status only).
type ComponentCheck func(ctx context.Context) error

const systemCheckTimeout = 2 * time.Second

// SystemHandlers serves GET /readyz and GET /v1/version
// (contracts/protocol-negotiation.md). /healthz semantics are owned by
// cmd/vod and are deliberately untouched.
type SystemHandlers struct {
	Build    buildinfo.Info
	Postgres ComponentCheck
	Prowlarr ComponentCheck
	// AllowedOrigins is the explicit CORS origin allowlist for the versioned
	// browser/mobile discovery surfaces (config.AllowedClientOriginList).
	// Wildcards are ignored; requests without Origin are unaffected.
	AllowedOrigins []string
}

// Register mounts the system endpoints additively. Version discovery and
// readiness carry origin-allowlisted CORS headers so allowlisted browser/
// mobile clients can negotiate before any workflow (FR-011: discovery is
// never gated).
func (h SystemHandlers) Register(mux *http.ServeMux) {
	allow := NewOriginAllowlist(h.AllowedOrigins)
	mux.HandleFunc("/readyz", allowlistCORS(allow, h.handleReadyz))
	mux.HandleFunc("/v1/version", allowlistCORS(allow, h.handleVersion))
}

func (h SystemHandlers) handleVersion(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(h.Build)
}

func (h SystemHandlers) handleReadyz(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	components := map[string]string{}
	ready := true
	if err := runComponentCheck(r.Context(), h.Postgres); err != nil {
		components["postgres"] = "unavailable"
		ready = false
	} else {
		components["postgres"] = "ok"
	}
	if err := runComponentCheck(r.Context(), h.Prowlarr); err != nil {
		components["prowlarr"] = "degraded"
	} else {
		components["prowlarr"] = "ok"
	}

	status := "ok"
	code := http.StatusOK
	if !ready {
		status = "unavailable"
		code = http.StatusServiceUnavailable
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"status":     status,
		"components": components,
	})
}

func runComponentCheck(ctx context.Context, check ComponentCheck) error {
	if check == nil {
		return nil
	}
	checkCtx, cancel := context.WithTimeout(ctx, systemCheckTimeout)
	defer cancel()
	return check(checkCtx)
}
