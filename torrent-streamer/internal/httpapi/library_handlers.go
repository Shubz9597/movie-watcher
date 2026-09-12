package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"torrent-streamer/internal/buildinfo"
	"torrent-streamer/internal/library"
)

// LibraryHandlers serves the household library contract finalized in
// specs/002-mobile-shared-ui/contracts/library-api.md (feature 002 M3.2).
// Register is a no-op when the storage-backed service is absent: the routes
// then do not exist (older servers 404 them) and library.household.v1 must
// not be advertised (contract §Errors and negotiation).
type LibraryHandlers struct {
	// Library is the storage-backed service; nil disables the surface.
	Library *library.Store
	Build   buildinfo.Info
	// AllowedOrigins is the explicit CORS origin allowlist for the versioned
	// browser/mobile surfaces (same policy as CatalogHandlers).
	AllowedOrigins []string
}

// Register mounts the /v2/library/* routes additively.
//
// CORS note (known accepted boundary, M5 hardening target): the PUT routes
// share the general allowlist, INCLUDING the documented opaque "null" entry,
// because the PACKAGED file:// Electron renderer (M3.3 LibraryToggle) is
// itself an opaque origin and must keep write access. A sandboxed iframe on
// a public page shares that Origin value, so opaque-origin writes are NOT
// attacker-proof today; Chromium Private Network Access is the current
// mitigation. The real fix is serving the desktop renderer from a
// non-opaque origin (M5 native shell) and then dropping "null" from the
// write allowlist — do not "harden" this earlier or the packaged desktop
// app loses its Library writes (contracts/library-api.md §CORS).
func (h LibraryHandlers) Register(mux *http.ServeMux) {
	if h.Library == nil {
		return
	}
	allow := NewOriginAllowlist(h.AllowedOrigins)
	routes := []struct {
		pattern string
		handler http.HandlerFunc
	}{
		{"GET /v2/library", h.handleList},
		{"GET /v2/library/overview", h.handleOverview},
		{"GET /v2/library/memberships", h.handleMemberships},
		{"PUT /v2/library/{id}/watch-later", h.handleWrite(library.CollectionWatchLater)},
		{"PUT /v2/library/{id}/favourite", h.handleWrite(library.CollectionFavourites)},
	}
	for _, route := range routes {
		mux.HandleFunc(route.pattern, allowlistCORS(allow, route.handler))
		// Browser/mobile cross-origin preflights arrive as OPTIONS; the
		// allowlist answers them at the same path.
		mux.HandleFunc("OPTIONS "+strings.TrimPrefix(strings.TrimPrefix(route.pattern, "GET "), "PUT "),
			allowlistCORS(allow, func(http.ResponseWriter, *http.Request) {}))
	}
}

func (h LibraryHandlers) handleList(w http.ResponseWriter, r *http.Request) {
	if !negotiationContext(w, r, h.Build) {
		return
	}
	query := r.URL.Query()
	limitRaw := query.Get("limit")
	limit := 0
	if limitRaw != "" {
		parsed, err := strconv.Atoi(limitRaw)
		if err != nil || parsed < 1 || parsed > 100 {
			writeLibraryError(w, http.StatusBadRequest, "invalid_request", "limit must be an integer between 1 and 100")
			return
		}
		limit = parsed
	}
	page, err := h.Library.Page(r.Context(),
		query.Get("collection"), query.Get("kind"), query.Get("sort"), query.Get("cursor"), limit)
	if err != nil {
		writeLibraryQueryError(w, err)
		return
	}
	response := map[string]any{
		"collection": page.Collection,
		"kind":       page.Kind,
		"sort":       page.Sort,
		"revision":   library.RevisionString(page.Revision),
		"total":      page.Total,
		"items":      orEmptySlice2(page.Items),
		"degraded":   false,
	}
	if page.NextCursor != "" {
		response["nextCursor"] = page.NextCursor
	}
	writeCatalogJSON(w, http.StatusOK, response)
}

// handleMemberships serves GET /v2/library/memberships?ids=a,b,c — the
// per-title reconciliation source for cross-client synchronization (repair
// pass, additive to contracts/library-api.md). An omitted id at revision R
// proves absence for clients whose per-title state is older than R.
func (h LibraryHandlers) handleMemberships(w http.ResponseWriter, r *http.Request) {
	if !negotiationContext(w, r, h.Build) {
		return
	}
	raw := strings.Split(r.URL.Query().Get("ids"), ",")
	ids := make([]string, 0, len(raw))
	for _, id := range raw {
		if trimmed := strings.TrimSpace(id); trimmed != "" {
			ids = append(ids, trimmed)
		}
	}
	if len(ids) == 0 {
		writeLibraryError(w, http.StatusBadRequest, "invalid_request", "ids must be a comma-separated list of canonical ids")
		return
	}
	if len(ids) > 100 {
		writeLibraryError(w, http.StatusBadRequest, "invalid_request", "at most 100 ids per request")
		return
	}
	entries, revision, err := h.Library.MembershipsFor(r.Context(), ids)
	if err != nil {
		writeLibraryError(w, http.StatusInternalServerError, "library_error", "library operation failed")
		return
	}
	if entries == nil {
		entries = []library.MembershipEntry{}
	}
	writeCatalogJSON(w, http.StatusOK, map[string]any{
		"revision":    library.RevisionString(revision),
		"memberships": entries,
	})
}

func (h LibraryHandlers) handleOverview(w http.ResponseWriter, r *http.Request) {
	if !negotiationContext(w, r, h.Build) {
		return
	}
	query := r.URL.Query()
	overview, err := h.Library.Overview(r.Context(), query.Get("collection"), query.Get("sort"))
	if err != nil {
		writeLibraryQueryError(w, err)
		return
	}
	shelves := make([]map[string]any, 0, len(overview.Shelves))
	for _, shelf := range overview.Shelves {
		shelves = append(shelves, map[string]any{
			"kind":     shelf.Kind,
			"count":    shelf.Count,
			"previews": orEmptySlice2(shelf.Previews),
		})
	}
	// sourceRev mirrors the snapshot revision until the recommendation
	// candidate source (M4) introduces its own revision input.
	writeCatalogJSON(w, http.StatusOK, map[string]any{
		"collection": overview.Collection,
		"sort":       overview.Sort,
		"revision":   library.RevisionString(overview.Revision),
		"sourceRev":  library.RevisionString(overview.SourceRev),
		"shelves":    shelves,
		"degraded":   false,
	})
}

type libraryWriteBody struct {
	Enabled *bool `json:"enabled"`
}

func (h LibraryHandlers) handleWrite(field string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !negotiationContext(w, r, h.Build) {
			return
		}
		canonicalID := r.PathValue("id")
		var body libraryWriteBody
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil || body.Enabled == nil {
			writeLibraryError(w, http.StatusBadRequest, "invalid_request", "body must be JSON with a boolean \"enabled\" field")
			return
		}
		result, err := h.Library.Write(r.Context(), library.Write{
			CanonicalID: canonicalID,
			Field:       field,
			Enabled:     *body.Enabled,
		})
		if err != nil {
			writeLibraryQueryError(w, err)
			return
		}
		writeCatalogJSON(w, http.StatusOK, map[string]any{
			"canonicalId": result.CanonicalID,
			"watchLater":  result.WatchLater,
			"favourite":   result.Favourite,
			"revision":    library.RevisionString(result.Revision),
			"updatedAt":   result.UpdatedAt,
		})
	}
}

func writeLibraryQueryError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, library.ErrInvalidRequest):
		writeLibraryError(w, http.StatusBadRequest, "invalid_request", err.Error())
	case errors.Is(err, library.ErrTitleNotFound):
		writeLibraryError(w, http.StatusNotFound, "title_not_found", "no catalog provider knows this title and no stored snapshot exists")
	case errors.Is(err, library.ErrUnavailable):
		writeLibraryError(w, http.StatusServiceUnavailable, "providers_unavailable", "metadata resolution failed for this write")
	default:
		writeLibraryError(w, http.StatusInternalServerError, "library_error", "library operation failed")
	}
}

func writeLibraryError(w http.ResponseWriter, status int, code, message string) {
	writeCatalogError(w, status, code, message)
}

func orEmptySlice2[T any](values []T) []T {
	if values == nil {
		return []T{}
	}
	return values
}
