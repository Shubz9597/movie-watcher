package httpapi

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"

	"torrent-streamer/internal/middleware"
	"torrent-streamer/internal/scoring"
	"torrent-streamer/internal/torrentx"
	"torrent-streamer/internal/watch"
)

type SessionDeps struct {
	Picks       torrentx.EnsureDeps // Repo + Search
	Watch       *watch.Store        // progress store (database/sql)
	ProfileCaps scoring.ProfileCaps // default device capabilities for scoring
}

type SessionHandlers struct {
	d SessionDeps
}

func NewSessionHandlers(d SessionDeps) *SessionHandlers { return &SessionHandlers{d: d} }

// Register mounts all /v1 session/resume routes with the same CORS behavior you use elsewhere.
func (h *SessionHandlers) Register(mux *http.ServeMux) {
	mux.HandleFunc("/v1/session/start", cors(h.Start))
	mux.HandleFunc("/v1/session/heartbeat", cors(h.Heartbeat))
	mux.HandleFunc("/v1/resume", cors(h.Resume))
	mux.HandleFunc("/v1/continue", cors(h.ContinueList))
	mux.HandleFunc("/v1/continue/dismiss", cors(h.ContinueDismiss))
}

func cors(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		middleware.EnableCORS(w)
		if r.Method == http.MethodOptions {
			return
		}
		next(w, r)
	}
}

func (h *SessionHandlers) Start(w http.ResponseWriter, r *http.Request) {
	var in struct {
		SeriesID, SeriesTitle, Kind string
		Season, Episode             int
		AbsEpisode                  *int
		ProfileHash                 string
		EstRuntimeMin               float64
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}

	p, err := torrentx.EnsurePick(r.Context(), h.d.Picks, torrentx.EnsureInput{
		SeriesID: in.SeriesID, SeriesTitle: in.SeriesTitle, Kind: in.Kind,
		Season: in.Season, Episode: in.Episode, AbsEpisode: in.AbsEpisode,
		ProfileHash: in.ProfileHash, EstRuntimeMin: in.EstRuntimeMin,
		ProfileCaps: h.d.ProfileCaps, // ← important: pass caps to scoring
	})
	if err != nil {
		http.Error(w, "pick error: "+err.Error(), http.StatusInternalServerError)
		return
	}

	streamURL := "/stream?magnet=" + url.QueryEscape(p.Magnet)
	if p.FileIndex != nil {
		streamURL += "&fileIndex=" + strconv.Itoa(*p.FileIndex)
	}

	_ = json.NewEncoder(w).Encode(map[string]any{
		"sessionId": "",
		"pick":      p,
		"streamUrl": streamURL,
		"nextHint":  map[string]any{"seriesId": in.SeriesID, "season": in.Season, "episode": in.Episode + 1, "ready": false},
	})
}

func (h *SessionHandlers) Heartbeat(w http.ResponseWriter, r *http.Request) {
	var in struct {
		SubjectID, SeriesID  string
		Season, Episode      int
		PositionS, DurationS int
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	if in.SubjectID == "" || in.SeriesID == "" {
		http.Error(w, "subjectId & seriesId required", http.StatusBadRequest)
		return
	}
	if err := h.d.Watch.SaveProgress(r.Context(), in.SubjectID, in.SeriesID, in.Season, in.Episode, in.PositionS, in.DurationS); err != nil {
		http.Error(w, "db error", http.StatusInternalServerError)
		return
	}
	// auto-complete at ≥95%
	if in.DurationS > 0 && float64(in.PositionS)/float64(in.DurationS)*100.0 >= 95.0 {
		_ = h.d.Watch.MarkCompleted(r.Context(), in.SubjectID, in.SeriesID, in.Season, in.Episode)
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
}

func (h *SessionHandlers) Resume(w http.ResponseWriter, r *http.Request) {
	subject := r.URL.Query().Get("subjectId")
	series := r.URL.Query().Get("seriesId")
	if subject == "" || series == "" {
		http.Error(w, "subjectId & seriesId required", http.StatusBadRequest)
		return
	}
	res, ok, err := h.d.Watch.GetResume(r.Context(), subject, series)
	if err != nil {
		http.Error(w, "db error", http.StatusInternalServerError)
		return
	}
	if !ok {
		_ = json.NewEncoder(w).Encode(map[string]any{"found": false})
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{
		"seriesId": res.SeriesID, "season": res.Season, "episode": res.Episode, "position_s": res.Position,
	})
}

func (h *SessionHandlers) ContinueList(w http.ResponseWriter, r *http.Request) {
	subject := r.URL.Query().Get("subjectId")
	if subject == "" {
		http.Error(w, "subjectId required", http.StatusBadRequest)
		return
	}
	limit := 30
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	items, err := h.d.Watch.ListContinue(r.Context(), subject, limit)
	if err != nil {
		http.Error(w, "db error", http.StatusInternalServerError)
		return
	}
	_ = json.NewEncoder(w).Encode(items)
}

func (h *SessionHandlers) ContinueDismiss(w http.ResponseWriter, r *http.Request) {
	var in struct {
		SubjectID, SeriesID string
		Season, Episode     int
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	if in.SubjectID == "" || in.SeriesID == "" {
		http.Error(w, "subjectId & seriesId required", http.StatusBadRequest)
		return
	}
	if err := h.d.Watch.Dismiss(r.Context(), in.SubjectID, in.SeriesID, in.Season, in.Episode, "manual"); err != nil {
		http.Error(w, "db error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
