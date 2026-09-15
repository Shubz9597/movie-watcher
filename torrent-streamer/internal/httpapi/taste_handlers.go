package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"torrent-streamer/internal/middleware"
)

// RegisterTasteRoutes registers the v2 taste-signal ingestion route.
// Fire-and-forget by contract: the client never surfaces failures.
func RegisterTasteRoutes(mux *http.ServeMux, taste tasteVisitor) {
	mux.HandleFunc("POST /v1/taste/visited", handleTasteVisited(taste))
}

// tasteVisitor is the bounded interface the handler needs (internal/taste
// Store satisfies it).
type tasteVisitor interface {
	RecordVisit(ctx context.Context, subjectID, canonicalID, kind string) error
}

func handleTasteVisited(taste tasteVisitor) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		middleware.EnableCORS(w)
		if r.Method == http.MethodOptions {
			return
		}
		var body struct {
			SubjectID   string `json:"subjectId"`
			CanonicalID string `json:"canonicalId"`
			Kind        string `json:"kind"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2048)).Decode(&body); err != nil {
			http.Error(w, "invalid request", http.StatusBadRequest)
			return
		}
		// Bound everything: a hostile body cannot create unbounded rows.
		body.SubjectID = strings.TrimSpace(body.SubjectID)
		body.CanonicalID = strings.TrimSpace(body.CanonicalID)
		body.Kind = strings.TrimSpace(body.Kind)
		if len(body.SubjectID) > 128 || len(body.CanonicalID) > 128 || len(body.Kind) > 32 {
			http.Error(w, "invalid request", http.StatusBadRequest)
			return
		}
		if body.SubjectID == "" || body.CanonicalID == "" {
			http.Error(w, "subjectId and canonicalId required", http.StatusBadRequest)
			return
		}
		// Fire-and-forget contract: errors are swallowed after logging —
		// the client never retries a taste ping.
		if err := taste.RecordVisit(r.Context(), body.SubjectID, body.CanonicalID, body.Kind); err != nil {
			writeCatalogJSON(w, http.StatusOK, map[string]bool{"ok": false})
			return
		}
		writeCatalogJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}
