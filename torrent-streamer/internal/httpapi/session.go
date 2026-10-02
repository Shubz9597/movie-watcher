package httpapi

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"torrent-streamer/internal/middleware"
	"torrent-streamer/internal/watch"
)

type SessionDeps struct {
	Watch *watch.Store // progress store (database/sql)
}

type SessionHandlers struct {
	d SessionDeps
}

const resumeRewindSeconds = 15

func rewindResumePosition(position int) int {
	if position <= resumeRewindSeconds {
		return 0
	}
	return position - resumeRewindSeconds
}

func NewSessionHandlers(d SessionDeps) *SessionHandlers { return &SessionHandlers{d: d} }

// Register mounts all /v1 session/resume routes with the same CORS behavior you use elsewhere.
func (h *SessionHandlers) Register(mux *http.ServeMux) {
	mux.HandleFunc("/v1/session/heartbeat", cors(h.Heartbeat))
	mux.HandleFunc("/v1/resume", cors(h.Resume))
	mux.HandleFunc("/v1/resume/source", cors(h.ResumeSource))
	mux.HandleFunc("/v1/continue", cors(h.ContinueList))
	mux.HandleFunc("/v1/continue/dismiss", cors(h.ContinueDismiss))
	mux.HandleFunc("/v1/watched", cors(h.Watched))
	mux.HandleFunc("/v1/watched/sync", cors(h.WatchedSync))
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

func (h *SessionHandlers) Heartbeat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var in struct {
		SubjectID       string `json:"subjectId"`
		SeriesID        string `json:"seriesId"`
		Season          int    `json:"season"`
		Episode         int    `json:"episode"`
		PositionS       int    `json:"position_s"`
		DurationS       int    `json:"duration_s"`
		SourceURI       string `json:"sourceUri"`
		SourceName      string `json:"sourceName"`
		SourceKind      string `json:"sourceKind"`
		SourceFileIndex *int   `json:"sourceFileIndex"`
		NextSeason      *int   `json:"nextSeason"`
		NextEpisode     *int   `json:"nextEpisode"`
		ClientID        string `json:"clientId"`
		SessionID       string `json:"sessionId"`
		Seq             int64  `json:"seq"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	if in.SubjectID == "" || in.SeriesID == "" {
		http.Error(w, "subjectId & seriesId required", http.StatusBadRequest)
		return
	}
	var source *watch.ProgressSource
	if strings.TrimSpace(in.SourceURI) != "" {
		source = &watch.ProgressSource{
			URI: in.SourceURI, Name: in.SourceName, Kind: in.SourceKind, FileIndex: in.SourceFileIndex,
		}
	}
	var next *watch.EpisodeRef
	if in.NextSeason != nil || in.NextEpisode != nil {
		if in.NextSeason == nil || in.NextEpisode == nil {
			http.Error(w, "nextSeason & nextEpisode must be provided together", http.StatusBadRequest)
			return
		}
		if *in.NextSeason < 0 || *in.NextEpisode <= 0 || (*in.NextSeason == in.Season && *in.NextEpisode == in.Episode) {
			http.Error(w, "invalid next episode", http.StatusBadRequest)
			return
		}
		next = &watch.EpisodeRef{Season: *in.NextSeason, Episode: *in.NextEpisode}
	}
	// Server-ordered write path (FR-006): commit-order LWW with per-session
	// seq guard. clientId is opaque last-writer metadata, never auth (FR-013).
	result, err := h.d.Watch.SaveProgressUpdate(r.Context(), watch.ProgressUpdate{
		SubjectID: in.SubjectID,
		SeriesID:  in.SeriesID,
		Season:    in.Season,
		Episode:   in.Episode,
		Position:  in.PositionS,
		Duration:  in.DurationS,
		Source:    source,
		Next:      next,
		ClientID:  in.ClientID,
		SessionID: in.SessionID,
		Seq:       in.Seq,
	})
	if err != nil {
		http.Error(w, "db error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if result.Ignored != "" {
		// Contract: naive callers get a 200 with an explicit ignored reason so
		// a delayed retry never moves progress backward.
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "ignored": result.Ignored})
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
}

func (h *SessionHandlers) ResumeSource(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	q := r.URL.Query()
	subject, series := strings.TrimSpace(q.Get("subjectId")), strings.TrimSpace(q.Get("seriesId"))
	season, seasonErr := strconv.Atoi(q.Get("season"))
	episode, episodeErr := strconv.Atoi(q.Get("episode"))
	if subject == "" || series == "" || seasonErr != nil || episodeErr != nil || season < 0 || episode < 0 {
		http.Error(w, "subjectId, seriesId, season & episode required", http.StatusBadRequest)
		return
	}
	source, ok, err := h.d.Watch.GetProgressSource(r.Context(), subject, series, season, episode)
	if err != nil {
		http.Error(w, "db error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	if !ok {
		_ = json.NewEncoder(w).Encode(map[string]any{"found": false})
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{
		"found":      true,
		"sourceUri":  source.URI,
		"sourceName": source.Name,
		"sourceKind": source.Kind,
		"fileIndex":  source.FileIndex,
	})
}

func (h *SessionHandlers) Resume(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	subject := r.URL.Query().Get("subjectId")
	series := r.URL.Query().Get("seriesId")
	if subject == "" || series == "" {
		http.Error(w, "subjectId & seriesId required", http.StatusBadRequest)
		return
	}
	var res watch.Resume
	var ok bool
	var err error
	seasonRaw, episodeRaw := r.URL.Query().Get("season"), r.URL.Query().Get("episode")
	if seasonRaw != "" || episodeRaw != "" {
		season, seasonErr := strconv.Atoi(seasonRaw)
		episode, episodeErr := strconv.Atoi(episodeRaw)
		if seasonErr != nil || episodeErr != nil || season < 0 || episode < 0 {
			http.Error(w, "valid season & episode required together", http.StatusBadRequest)
			return
		}
		res, ok, err = h.d.Watch.GetEpisodeResume(r.Context(), subject, series, season, episode)
	} else {
		res, ok, err = h.d.Watch.GetResume(r.Context(), subject, series)
	}
	if err != nil {
		http.Error(w, "db error", http.StatusInternalServerError)
		return
	}
	if !ok {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"found": false})
		return
	}
	pos := rewindResumePosition(res.Position)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"found": true, "seriesId": res.SeriesID, "season": res.Season, "episode": res.Episode,
		"position_s": pos, "duration_s": res.Duration, "percent": res.Percent,
	})
}

func (h *SessionHandlers) ContinueList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
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
		log.Printf("[continue] query failed: %v", err)
		http.Error(w, "db error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if items == nil {
		items = []watch.ContinueItem{}
	}
	_ = json.NewEncoder(w).Encode(items)
}

func (h *SessionHandlers) ContinueDismiss(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
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

// Watched serves per-title watched state (GET ?subjectId=&seriesId=) and
// manual marking (POST {subjectId, seriesId, items:[{season,episode}],
// watched, next?}). Marking watched with next queues that episode in
// Continue watching, like finishing playback does.
func (h *SessionHandlers) Watched(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		subjectID := strings.TrimSpace(r.URL.Query().Get("subjectId"))
		seriesID := strings.TrimSpace(r.URL.Query().Get("seriesId"))
		if subjectID == "" || seriesID == "" {
			http.Error(w, "subjectId & seriesId required", http.StatusBadRequest)
			return
		}
		items, err := h.d.Watch.ListWatched(r.Context(), subjectID, seriesID)
		if err != nil {
			http.Error(w, "db error", http.StatusInternalServerError)
			return
		}
		type itemBody struct {
			Season    int     `json:"season"`
			Episode   int     `json:"episode"`
			PositionS int     `json:"position_s"`
			DurationS int     `json:"duration_s"`
			Percent   float64 `json:"percent"`
			Watched   bool    `json:"watched"`
		}
		body := struct {
			Threshold float64    `json:"threshold"`
			Items     []itemBody `json:"items"`
		}{Threshold: watch.CompletedPercent, Items: make([]itemBody, 0, len(items))}
		for _, item := range items {
			body.Items = append(body.Items, itemBody{item.Season, item.Episode, item.PositionS, item.DurationS, item.Percent, item.Watched})
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(body)
	case http.MethodPost:
		var in struct {
			SubjectID string `json:"subjectId"`
			SeriesID  string `json:"seriesId"`
			Items     []struct {
				Season  int `json:"season"`
				Episode int `json:"episode"`
			} `json:"items"`
			Watched bool `json:"watched"`
			Next    *struct {
				Season  int `json:"season"`
				Episode int `json:"episode"`
			} `json:"next"`
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		if in.SubjectID == "" || in.SeriesID == "" || len(in.Items) == 0 || len(in.Items) > 500 {
			http.Error(w, "subjectId, seriesId and 1-500 items required", http.StatusBadRequest)
			return
		}
		refs := make([]watch.EpisodeRef, 0, len(in.Items))
		for _, item := range in.Items {
			if item.Season < 0 || item.Episode < 0 {
				http.Error(w, "season/episode must be >= 0", http.StatusBadRequest)
				return
			}
			refs = append(refs, watch.EpisodeRef{Season: item.Season, Episode: item.Episode})
		}
		var next *watch.EpisodeRef
		if in.Next != nil && in.Next.Episode > 0 && in.Next.Season >= 0 {
			next = &watch.EpisodeRef{Season: in.Next.Season, Episode: in.Next.Episode}
		}
		if err := h.d.Watch.SetWatched(r.Context(), in.SubjectID, in.SeriesID, refs, in.Watched, next); err != nil {
			http.Error(w, "db error", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		w.Header().Set("Allow", "GET, POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// WatchedSync applies positions a device recorded while offline (POST
// {subjectId, items:[{seriesId, season, episode, position_s, duration_s,
// watchedAt}]}, watchedAt in epoch seconds). Responds {applied}.
func (h *SessionHandlers) WatchedSync(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var in struct {
		SubjectID string `json:"subjectId"`
		Items     []struct {
			SeriesID  string  `json:"seriesId"`
			Season    int     `json:"season"`
			Episode   int     `json:"episode"`
			PositionS float64 `json:"position_s"`
			DurationS float64 `json:"duration_s"`
			WatchedAt float64 `json:"watchedAt"`
		} `json:"items"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	if in.SubjectID == "" || len(in.Items) > 500 {
		http.Error(w, "subjectId and at most 500 items required", http.StatusBadRequest)
		return
	}
	items := make([]watch.OfflineProgress, 0, len(in.Items))
	for _, item := range in.Items {
		if item.Season < 0 || item.Episode < 0 {
			continue
		}
		items = append(items, watch.OfflineProgress{
			SeriesID: strings.TrimSpace(item.SeriesID), Season: item.Season, Episode: item.Episode,
			PositionS: int(item.PositionS), DurationS: int(item.DurationS),
			WatchedAt: time.Unix(int64(item.WatchedAt), 0),
		})
	}
	applied, err := h.d.Watch.SyncOffline(r.Context(), in.SubjectID, items)
	if err != nil {
		http.Error(w, "db error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]int{"applied": applied})
}
