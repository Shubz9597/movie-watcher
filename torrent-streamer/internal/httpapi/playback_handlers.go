package httpapi

import (
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"torrent-streamer/internal/buildinfo"
	"torrent-streamer/internal/playback"
)

// playbackAllowedMethods extends the versioned-surface CORS methods for the
// playback contract (POST to create sessions, DELETE to stop them). This is
// scoped to the playback routes only; the library surface keeps its tighter
// policy. Wildcard origins are still rejected by the same allowlist.
const playbackAllowedMethods = "GET, HEAD, OPTIONS, POST, DELETE"

// PlaybackHandlers serves the versioned mobile playback compatibility
// contract (M1.3.3+). Register is a no-op when the service is absent, so an
// unconfigured server 404s these routes and never advertises the capability.
type PlaybackHandlers struct {
	Manager        *playback.Manager
	Build          buildinfo.Info
	AllowedOrigins []string
	// PlaybackRoot is the manager's configured data root (session files are
	// served only from within it).
	PlaybackRoot string
}

// Register mounts /v2/playback/* additively.
func (h PlaybackHandlers) Register(mux *http.ServeMux) {
	if h.Manager == nil {
		return
	}
	allow := NewOriginAllowlist(h.AllowedOrigins)
	playbackCORS := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			origin := strings.TrimSpace(r.Header.Get("Origin"))
			if origin != "" {
				if !allow.Allows(origin) {
					if r.Method == http.MethodOptions {
						return
					}
					// No CORS headers for disallowed origins; non-browser
					// callers (native apps) are unaffected.
				} else {
					w.Header().Set("Access-Control-Allow-Origin", origin)
					w.Header().Set("Vary", "Origin")
					w.Header().Set("Access-Control-Allow-Methods", playbackAllowedMethods)
					w.Header().Set("Access-Control-Allow-Headers", corsAllowedHeaders)
					w.Header().Set("Access-Control-Max-Age", "600")
				}
			}
			if r.Method == http.MethodOptions {
				return
			}
			next(w, r)
		}
	}

	mux.HandleFunc("POST /v2/playback/sessions", playbackCORS(h.handleCreate))
	mux.HandleFunc("OPTIONS /v2/playback/sessions", playbackCORS(func(http.ResponseWriter, *http.Request) {}))
	mux.HandleFunc("GET /v2/playback/sessions/{id}", playbackCORS(h.handleGet))
	mux.HandleFunc("DELETE /v2/playback/sessions/{id}", playbackCORS(h.handleDelete))
	mux.HandleFunc("OPTIONS /v2/playback/sessions/{id}", playbackCORS(func(http.ResponseWriter, *http.Request) {}))
	mux.HandleFunc("GET /v2/playback/sessions/{id}/master.m3u8", playbackCORS(h.handleMaster))
	mux.HandleFunc("GET /v2/playback/sessions/{id}/media", playbackCORS(h.handleMedia))
	mux.HandleFunc("GET /v2/playback/sessions/{id}/hls/", playbackCORS(h.handleHLSFile))
	mux.HandleFunc("GET /v2/playback/sessions/{id}/subtitles/", playbackCORS(h.handleSubtitle))
}

type createSessionRequest struct {
	Cat       string `json:"cat"`
	SourceID  string `json:"sourceId"`
	FileIndex *int   `json:"fileIndex"`
	Profile   string `json:"profile"`
}

func (h PlaybackHandlers) handleCreate(w http.ResponseWriter, r *http.Request) {
	if !negotiationContext(w, r, h.Build) {
		return
	}
	var body createSessionRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&body); err != nil {
		writePlaybackError(w, http.StatusBadRequest, "invalid_request", "The session request body could not be read.")
		return
	}
	fileIndex := 0
	if body.FileIndex != nil {
		fileIndex = *body.FileIndex
	}
	if body.Profile == "" {
		body.Profile = "ios-avplayer"
	}
	view, err := h.Manager.Create(r.Context(), body.Cat, body.SourceID, fileIndex, body.Profile)
	if err != nil {
		writePlaybackServiceError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(view)
}

func (h PlaybackHandlers) handleGet(w http.ResponseWriter, r *http.Request) {
	if !negotiationContext(w, r, h.Build) {
		return
	}
	view, ok := h.Manager.Get(r.PathValue("id"))
	if !ok {
		writePlaybackError(w, http.StatusNotFound, "session_not_found", "This playback session is unknown or has expired.")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(view)
}

func (h PlaybackHandlers) handleDelete(w http.ResponseWriter, r *http.Request) {
	if !negotiationContext(w, r, h.Build) {
		return
	}
	if !h.Manager.Delete(r.PathValue("id")) {
		// DELETE is idempotent from the client's perspective.
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h PlaybackHandlers) handleMaster(w http.ResponseWriter, r *http.Request) {
	if !negotiationContext(w, r, h.Build) {
		return
	}
	sess, ok := h.Manager.Lookup(r.PathValue("id"))
	if !ok || !sess.HasHLS() {
		writePlaybackError(w, http.StatusNotFound, "session_not_found", "This playback session is unknown, expired, or has no HLS rendition.")
		return
	}
	w.Header().Set("Content-Type", playback.MIMEPlaylist)
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write([]byte(playback.WriteMasterPlaylist(sess)))
}

// handleMedia serves the DIRECT-mode rendition through an opaque session URL.
// The torrent reader provides Range semantics; no magnet or path is exposed.
func (h PlaybackHandlers) handleMedia(w http.ResponseWriter, r *http.Request) {
	if !negotiationContext(w, r, h.Build) {
		return
	}
	sess, ok := h.Manager.Lookup(r.PathValue("id"))
	if !ok || sess.MediaOpen() == nil {
		writePlaybackError(w, http.StatusNotFound, "session_not_found", "This playback session is unknown, expired, or has no direct rendition.")
		return
	}
	reader, err := sess.MediaOpen()()
	if err != nil {
		writePlaybackError(w, http.StatusServiceUnavailable, "media_unavailable", "The media is not readable yet. Try again shortly.")
		return
	}
	defer reader.Close()
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Content-Type", mediaContentType(sess.MediaName()))
	http.ServeContent(w, r, sess.MediaName(), time.Time{}, reader)
}

func (h PlaybackHandlers) handleHLSFile(w http.ResponseWriter, r *http.Request) {
	if !negotiationContext(w, r, h.Build) {
		return
	}
	id := r.PathValue("id")
	sess, ok := h.Manager.Lookup(id)
	if !ok || !sess.HasHLS() {
		writePlaybackError(w, http.StatusNotFound, "session_not_found", "This playback session is unknown, expired, or has no HLS rendition.")
		return
	}
	relative := strings.TrimPrefix(r.URL.Path, "/v2/playback/sessions/"+id+"/hls/")
	contentType := playback.MIMESegment
	if strings.HasSuffix(relative, ".m3u8") {
		contentType = playback.MIMEPlaylist
	}
	playback.ServeSessionFile(w, r, h.PlaybackRoot, id, relative, contentType)
}

func (h PlaybackHandlers) handleSubtitle(w http.ResponseWriter, r *http.Request) {
	if !negotiationContext(w, r, h.Build) {
		return
	}
	id := r.PathValue("id")
	if _, ok := h.Manager.Lookup(id); !ok {
		writePlaybackError(w, http.StatusNotFound, "session_not_found", "This playback session is unknown or expired.")
		return
	}
	relative := strings.TrimPrefix(r.URL.Path, "/v2/playback/sessions/"+id+"/subtitles/")
	contentType := playback.MIMESubtitle
	switch strings.ToLower(filepath.Ext(relative)) {
	case ".ass", ".ssa":
		contentType = "text/x-ssa; charset=utf-8"
	case ".srt":
		contentType = "application/x-subrip; charset=utf-8"
	}
	playback.ServeSessionFile(w, r, h.PlaybackRoot, id, relative, contentType)
}

func mediaContentType(name string) string {
	if ct := mime.TypeByExtension(strings.ToLower(filepath.Ext(name))); ct != "" {
		return ct
	}
	return "video/mp4"
}

func writePlaybackServiceError(w http.ResponseWriter, err error) {
	if svcErr, ok := err.(*playback.Error); ok {
		status := http.StatusBadRequest
		switch svcErr.Code {
		case playback.ReasonCapacityExhausted, playback.ReasonSessionLimit:
			status = http.StatusServiceUnavailable
		case "internal", "unavailable":
			status = http.StatusInternalServerError
		case playback.ReasonMediaInspectionFail, playback.ReasonMalformedSource:
			status = http.StatusUnprocessableEntity
		}
		writePlaybackError(w, status, svcErr.Code, svcErr.Message)
		return
	}
	writePlaybackError(w, http.StatusInternalServerError, "internal", "The playback service could not complete the request.")
}

func writePlaybackError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]string{"code": code, "message": message},
	})
}
