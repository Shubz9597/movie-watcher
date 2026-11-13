package httpapi

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"

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
	if !h.Recommendations.Learns() {
		return
	}
	// Learning (recommendations.learning.v1): cards seen, "not interested",
	// and what came of the recommendations.
	mux.HandleFunc("POST /v2/recommendations/seen", allowlistCORS(allow, h.handleSeen))
	mux.HandleFunc("OPTIONS /v2/recommendations/seen", allowlistCORS(allow, func(http.ResponseWriter, *http.Request) {}))
	mux.HandleFunc("POST /v2/recommendations/feedback", allowlistCORS(allow, h.handleFeedback))
	mux.HandleFunc("OPTIONS /v2/recommendations/feedback", allowlistCORS(allow, func(http.ResponseWriter, *http.Request) {}))
	mux.HandleFunc("GET /v2/recommendations/stats", allowlistCORS(allow, h.handleStats))
	mux.HandleFunc("OPTIONS /v2/recommendations/stats", allowlistCORS(allow, func(http.ResponseWriter, *http.Request) {}))
}

// POST /v2/recommendations/seen {items: [{canonicalId, position}]}: cards
// that were on screen.
func (h RecommendationHandlers) handleSeen(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Items []struct {
			CanonicalID string `json:"canonicalId"`
			Position    int    `json:"position"`
		} `json:"items"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10)).Decode(&req); err != nil || len(req.Items) > 60 {
		writeCatalogError(w, http.StatusBadRequest, "invalid_request", "items: up to 60 {canonicalId, position}")
		return
	}
	ids := make([]string, 0, len(req.Items))
	positions := make([]int, 0, len(req.Items))
	for _, item := range req.Items {
		if id := strings.TrimSpace(item.CanonicalID); id != "" && len(id) <= 200 {
			ids = append(ids, id)
			positions = append(positions, max(0, item.Position))
		}
	}
	if err := h.Recommendations.Seen(r.Context(), ids, positions); err != nil {
		log.Printf("[recommendations] recording seen cards: %v", err)
		writeCatalogError(w, http.StatusInternalServerError, "storage_error", "could not record")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// POST /v2/recommendations/feedback {canonicalId, title, kind:
// "not_interested", undo}.
func (h RecommendationHandlers) handleFeedback(w http.ResponseWriter, r *http.Request) {
	var req struct {
		CanonicalID string `json:"canonicalId"`
		Title       string `json:"title"`
		Kind        string `json:"kind"`
		Undo        bool   `json:"undo"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req); err != nil ||
		strings.TrimSpace(req.CanonicalID) == "" || req.Kind != "not_interested" {
		writeCatalogError(w, http.StatusBadRequest, "invalid_request", "canonicalId and kind \"not_interested\" are required")
		return
	}
	title := strings.TrimSpace(req.Title)
	if r := []rune(title); len(r) > 200 {
		title = string(r[:200])
	}
	if err := h.Recommendations.NotInterested(r.Context(), strings.TrimSpace(req.CanonicalID), title, req.Undo); err != nil {
		log.Printf("[recommendations] feedback: %v", err)
		writeCatalogError(w, http.StatusInternalServerError, "storage_error", "could not record")
		return
	}
	writeCatalogJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// GET /v2/recommendations/stats?days=30
func (h RecommendationHandlers) handleStats(w http.ResponseWriter, r *http.Request) {
	days := 30
	if raw := r.URL.Query().Get("days"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 365 {
			writeCatalogError(w, http.StatusBadRequest, "invalid_request", "days must be 1-365")
			return
		}
		days = parsed
	}
	stats, err := h.Recommendations.Stats(r.Context(), days)
	if err != nil {
		writeCatalogError(w, http.StatusInternalServerError, "storage_error", "stats are unavailable")
		return
	}
	writeCatalogJSON(w, http.StatusOK, stats)
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
