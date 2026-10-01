package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"torrent-streamer/internal/buildinfo"
	"torrent-streamer/internal/downloads"
	"torrent-streamer/internal/search"
	"torrent-streamer/internal/torrentx"
)

type downloadSourceResolver interface {
	Resolve(context.Context, search.ResolveRequest) (search.ResolveResult, error)
}

type downloadPickStore interface {
	InsertPick(context.Context, torrentx.PickRow) (int64, error)
}

// DownloadsHandlers serves the offline-download preparation contract
// finalized in docs/offline-downloads/contracts.md (D01, implemented D02a).
// Register is a no-op when the store is absent: the routes then do not exist
// (older servers 404 them). The downloads.offline.v1 capability stays
// UNADVERTISED until the prep pipeline is functional (D02b) — these routes
// are safely inactive until then and clients never call unadvertised
// surfaces.
type DownloadsHandlers struct {
	// Store is the storage-backed service; nil disables the surface.
	Store downloads.Service
	// SourceResolver + Picks turn the renderer's opaque, short-lived source
	// selection into the durable internal pick required by the preparation
	// pipeline. Magnets and indexer URLs never enter the client request.
	SourceResolver downloadSourceResolver
	Picks          downloadPickStore
	Build          buildinfo.Info
	// AllowedOrigins is the explicit CORS origin allowlist for the versioned
	// browser/mobile surfaces (same policy as CatalogHandlers).
	AllowedOrigins []string
	// AssetRoot is the resolved downloads root the prepared files live under
	// (D02b). Empty disables the asset routes.
	AssetRoot string
	// Now is overridable for tests; UTC time is the default.
	Now func() time.Time
}

func (h DownloadsHandlers) now() time.Time {
	if h.Now != nil {
		return h.Now()
	}
	return time.Now().UTC()
}

// Register mounts the /v1/downloads/* routes additively.
func (h DownloadsHandlers) Register(mux *http.ServeMux) {
	if h.Store == nil {
		return
	}
	allow := NewOriginAllowlist(h.AllowedOrigins)
	routes := []struct {
		method  string
		path    string
		handler http.HandlerFunc
	}{
		{"POST", "/v1/downloads/jobs", h.handleCreate},
		{"GET", "/v1/downloads/jobs/{id}", h.handleGet},
		{"POST", "/v1/downloads/jobs/{id}/cancel", h.handleCancel},
		{"POST", "/v1/downloads/jobs/{id}/renew", h.handleRenew},
		{"GET", "/v1/downloads/jobs/{id}/manifest", h.handleManifest},
	}
	if h.AssetRoot != "" {
		routes = append(routes, struct {
			method  string
			path    string
			handler http.HandlerFunc
		}{"GET", "/v1/downloads/jobs/{id}/assets/{rest...}", h.handleAsset})
	}
	for _, route := range routes {
		mux.HandleFunc(route.method+" "+route.path, allowlistCORS(allow, route.handler))
		// Browser/mobile cross-origin preflights arrive as OPTIONS; the
		// allowlist answers them at the same path.
		mux.HandleFunc("OPTIONS "+route.path, allowlistCORS(allow, func(http.ResponseWriter, *http.Request) {}))
	}
}

func (h DownloadsHandlers) clientID(r *http.Request) string {
	return strings.TrimSpace(r.URL.Query().Get("clientId"))
}

func (h DownloadsHandlers) handleCreate(w http.ResponseWriter, r *http.Request) {
	if !negotiationContext(w, r, h.Build) {
		return
	}
	var body struct {
		ClientID       string `json:"clientId"`
		IdempotencyKey string `json:"idempotencyKey"`
		SeriesID       string `json:"seriesId"`
		Season         int    `json:"season"`
		Episode        int    `json:"episode"`
		PickID         int64  `json:"pickId"`
		SourceID       string `json:"sourceId"`
		SourceKind     string `json:"sourceKind"`
		FileIndex      *int   `json:"fileIndex"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeSystemError(w, http.StatusBadRequest, ErrorDetail{Code: "bad_json", Message: "The request body is not valid JSON."})
		return
	}
	pickID := body.PickID
	if pickID <= 0 && strings.TrimSpace(body.SourceID) != "" {
		var err error
		pickID, err = h.registerSelectedSource(
			r.Context(), body.SeriesID, body.SourceKind, body.SourceID,
			body.Season, body.Episode, body.FileIndex,
		)
		if err != nil {
			h.writeStoreError(w, err)
			return
		}
	}
	job, created, err := h.Store.Create(r.Context(), downloads.CreateRequest{
		ClientID:       body.ClientID,
		IdempotencyKey: body.IdempotencyKey,
		SeriesID:       body.SeriesID,
		Season:         body.Season,
		Episode:        body.Episode,
		PickID:         pickID,
	})
	if err != nil {
		h.writeStoreError(w, err)
		return
	}
	status := http.StatusCreated
	if !created {
		// Idempotent replay: the same attempt key returns the same job.
		status = http.StatusOK
	}
	writeJSON(w, status, h.jobBody(job))
}

func (h DownloadsHandlers) registerSelectedSource(
	ctx context.Context,
	seriesID string,
	sourceKind string,
	sourceID string,
	season int,
	episode int,
	fileIndex *int,
) (int64, error) {
	if h.SourceResolver == nil || h.Picks == nil || strings.TrimSpace(seriesID) == "" {
		return 0, downloads.ErrInvalidSource
	}
	switch sourceKind {
	case "movie", "tv", "anime":
	default:
		return 0, downloads.ErrInvalidSource
	}
	resolved, err := h.SourceResolver.Resolve(ctx, search.ResolveRequest{SourceID: strings.TrimSpace(sourceID)})
	if err != nil || resolved.MagnetURI == "" || resolved.InfoHash == "" {
		return 0, downloads.ErrInvalidSource
	}
	return h.Picks.InsertPick(ctx, torrentx.PickRow{
		SeriesID:    seriesID,
		Season:      season,
		Episode:     episode,
		ProfileHash: "download:" + strings.TrimSpace(sourceID),
		InfoHash:    resolved.InfoHash,
		Magnet:      resolved.MagnetURI,
		FileIndex:   fileIndex,
		SourceKind:  sourceKind,
		// picks.score is JSONB NOT NULL. This selected-source path does not run
		// the ranking engine, so persist its neutral, valid JSON value instead
		// of passing a nil []byte (which database/sql sends as SQL NULL).
		ScoreJSON: []byte("{}"),
		PickedAt:  time.Now().UTC(),
	})
}

func (h DownloadsHandlers) handleGet(w http.ResponseWriter, r *http.Request) {
	if !negotiationContext(w, r, h.Build) {
		return
	}
	clientID := h.clientID(r)
	jobID := r.PathValue("id")
	job, err := h.Store.Get(r.Context(), clientID, jobID)
	if err != nil {
		h.writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, h.jobBody(job))
}

func (h DownloadsHandlers) handleCancel(w http.ResponseWriter, r *http.Request) {
	if !negotiationContext(w, r, h.Build) {
		return
	}
	job, err := h.Store.Cancel(r.Context(), h.clientID(r), r.PathValue("id"))
	if err != nil {
		h.writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, h.jobBody(job))
}

func (h DownloadsHandlers) handleRenew(w http.ResponseWriter, r *http.Request) {
	if !negotiationContext(w, r, h.Build) {
		return
	}
	job, err := h.Store.Renew(r.Context(), h.clientID(r), r.PathValue("id"), h.now())
	if err != nil {
		h.writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, h.jobBody(job))
}

func (h DownloadsHandlers) handleManifest(w http.ResponseWriter, r *http.Request) {
	if !negotiationContext(w, r, h.Build) {
		return
	}
	manifest, err := h.Store.Manifest(r.Context(), h.clientID(r), r.PathValue("id"))
	if err != nil {
		h.writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, manifest)
}

// handleAsset serves one prepared asset file (contracts.md §4.1): exact
// Content-Length, stable ETag derived from the recorded SHA-256, and
// net/http's Range/If-Range handling for correct 200/206/416 semantics. Only
// files inside the resolved asset root are ever opened.
func (h DownloadsHandlers) handleAsset(w http.ResponseWriter, r *http.Request) {
	if !negotiationContext(w, r, h.Build) {
		return
	}
	clientID := h.clientID(r)
	jobID := r.PathValue("id")
	rest := r.PathValue("rest")
	if rest == "" || strings.Contains(rest, "..") {
		writeSystemError(w, http.StatusNotFound, ErrorDetail{Code: "not_found", Message: "That download does not exist."})
		return
	}
	urlPath := "/v1/downloads/jobs/" + jobID + "/assets/" + rest
	rel, _, sha, err := h.Store.AssetFile(r.Context(), clientID, jobID, urlPath)
	if err != nil {
		h.writeStoreError(w, err)
		return
	}
	disk := filepath.Join(h.AssetRoot, filepath.FromSlash(rel))
	rootAbs, err := filepath.Abs(h.AssetRoot)
	if err != nil {
		h.writeStoreError(w, err)
		return
	}
	diskAbs, err := filepath.Abs(disk)
	if err != nil || !strings.HasPrefix(diskAbs, rootAbs+string(filepath.Separator)) {
		writeSystemError(w, http.StatusNotFound, ErrorDetail{Code: "not_found", Message: "That download does not exist."})
		return
	}
	file, err := os.Open(diskAbs)
	if err != nil {
		writeSystemError(w, http.StatusNotFound, ErrorDetail{Code: "not_found", Message: "That download does not exist."})
		return
	}
	defer file.Close()
	// ETag from the exact recorded content hash: If-Range with a stale or
	// foreign validator downgrades to a full 200 (never mixed-revision
	// bytes, contracts.md §4.1).
	if len(sha) >= 32 {
		w.Header().Set("ETag", `"`+sha[:32]+`"`)
	}
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Cache-Control", "private, max-age=3600")
	http.ServeContent(w, r, filepath.Base(diskAbs), time.Time{}, file)
}

// jobBody is the client-facing job representation (contracts.md §3): safe
// fields only — no pick internals, no provider data. seriesId/season/episode
// let the client resolve display identity for its own inventory.
type jobBody struct {
	JobID      string     `json:"jobId"`
	SeriesID   string     `json:"seriesId"`
	Season     int        `json:"season"`
	Episode    int        `json:"episode"`
	State      string     `json:"state"`
	ReasonCode string     `json:"reasonCode"`
	ReadyAt    *time.Time `json:"readyAt,omitempty"`
	ExpiresAt  *time.Time `json:"expiresAt,omitempty"`
}

func (h DownloadsHandlers) jobBody(job downloads.Job) jobBody {
	return jobBody{
		JobID:      job.ID,
		SeriesID:   job.SeriesID,
		Season:     job.Season,
		Episode:    job.Episode,
		State:      job.State,
		ReasonCode: job.ReasonCode,
		ReadyAt:    job.ReadyAt,
		ExpiresAt:  job.ExpiresAt,
	}
}

// writeStoreError maps service errors onto the contract's safe responses
// (contracts.md §3 errors). Internal failures never leak details.
func (h DownloadsHandlers) writeStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, downloads.ErrNotFound), errors.Is(err, downloads.ErrNotReady):
		// A missing OR not-yet-ready package is uniformly "no manifest" —
		// never a partial manifest response (contracts.md §4).
		writeSystemError(w, http.StatusNotFound, ErrorDetail{Code: "not_found", Message: "That download does not exist."})
	case errors.Is(err, downloads.ErrNotCancellable):
		writeSystemError(w, http.StatusConflict, ErrorDetail{Code: "not_cancellable", Message: "That download cannot be cancelled in its current state."})
	case errors.Is(err, downloads.ErrExpired):
		writeSystemError(w, http.StatusConflict, ErrorDetail{Code: "retention_expired", Message: "That download's server preparation has expired. Prepare it again."})
	case errors.Is(err, downloads.ErrInvalidSource):
		writeSystemError(w, http.StatusBadRequest, ErrorDetail{Code: "invalid_source", Message: "That source could not be prepared for download."})
	case errors.Is(err, downloads.ErrInvalidRequest):
		writeSystemError(w, http.StatusBadRequest, ErrorDetail{Code: "bad_request", Message: "The download request is incomplete."})
	default:
		log.Printf("[downloads] request failed: %v", err)
		writeSystemError(w, http.StatusInternalServerError, ErrorDetail{Code: "download_failed", Message: "The download request could not be processed."})
	}
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
