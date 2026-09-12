package httpapi

import (
	"net/http"
	"strconv"

	"torrent-streamer/internal/buildinfo"
	"torrent-streamer/internal/recommendations"
)

// RecommendationHandlers serves GET /v2/recommendations (M4.1,
// contracts/recommendations-api.md). Register is a no-op without the wired
// service: the route does not exist and recommendations.basic.v1 must not be
// advertised (older servers 404 it).
type RecommendationHandlers struct {
	Recommendations *recommendations.Service
	Build           buildinfo.Info
	AllowedOrigins  []string
}

func (h RecommendationHandlers) Register(mux *http.ServeMux) {
	if h.Recommendations == nil {
		return
	}
	allow := NewOriginAllowlist(h.AllowedOrigins)
	mux.HandleFunc("GET /v2/recommendations", allowlistCORS(allow, h.handleRecommendations))
	mux.HandleFunc("OPTIONS /v2/recommendations", allowlistCORS(allow, func(http.ResponseWriter, *http.Request) {}))
}

func (h RecommendationHandlers) handleRecommendations(w http.ResponseWriter, r *http.Request) {
	if !negotiationContext(w, r, h.Build) {
		return
	}
	// Default 20, min 1, MAX 20 (contract). Invalid values are rejected, never
	// silently clamped.
	limit := recommendations.MaxLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > recommendations.MaxLimit {
			writeCatalogError(w, http.StatusBadRequest, "invalid_request", "limit must be an integer between 1 and 20")
			return
		}
		limit = parsed
	}

	result, err := h.Recommendations.Recommend(r.Context())
	if err != nil {
		writeCatalogError(w, http.StatusServiceUnavailable, "providers_unavailable", "recommendations are unavailable")
		return
	}
	items := result.Items
	if len(items) > limit {
		items = items[:limit]
	}
	if items == nil {
		items = []recommendations.Item{}
	}
	writeCatalogJSON(w, http.StatusOK, map[string]any{
		"revision":    strconv.FormatInt(result.Revision, 10),
		"fallback":    result.Fallback,
		"degraded":    result.Degraded,
		"generatedAt": result.GeneratedAt,
		"items":       items,
	})
}
