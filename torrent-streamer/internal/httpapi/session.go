package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

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
	mux.HandleFunc("/v1/session/start", cors(h.Start))
	mux.HandleFunc("/v1/session/heartbeat", cors(h.Heartbeat))
	mux.HandleFunc("/v1/session/ended", cors(h.Ended))
	mux.HandleFunc("/v1/resume", cors(h.Resume))
	mux.HandleFunc("/v1/resume/source", cors(h.ResumeSource))
	mux.HandleFunc("/v1/resume/source/probe", cors(h.ResumeSourceProbe))
	mux.HandleFunc("/v1/continue", cors(h.ContinueList))
	mux.HandleFunc("/v1/continue/dismiss", cors(h.ContinueDismiss))
	mux.HandleFunc("/v1/resume.m3u", cors(h.ResumeM3U))
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
	if err := h.d.Watch.SaveProgressUpdate(r.Context(), watch.ProgressUpdate{
		SubjectID: in.SubjectID,
		SeriesID:  in.SeriesID,
		Season:    in.Season,
		Episode:   in.Episode,
		Position:  in.PositionS,
		Duration:  in.DurationS,
		Source:    source,
		Next:      next,
	}); err != nil {
		http.Error(w, "db error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
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

func (h *SessionHandlers) ResumeSourceProbe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	respondUnavailable := func(reason string) {
		_ = json.NewEncoder(w).Encode(map[string]any{"playable": false, "reason": reason})
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
	if !ok {
		respondUnavailable("source_missing")
		return
	}

	kind := source.Kind
	if kind == "" {
		kind = "movie"
	}
	t, err := torrentx.AddOrGetTorrent(torrentx.GetClientFor(kind), source.URI)
	if err != nil {
		respondUnavailable("invalid_source")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	if err := torrentx.WaitForInfo(ctx, t); err != nil {
		respondUnavailable("metadata_timeout")
		return
	}

	fileIndex := -1
	var fileLength, completed int64
	if source.FileIndex != nil {
		if *source.FileIndex < 0 || *source.FileIndex >= len(t.Files()) {
			respondUnavailable("file_missing")
			return
		}
		fileIndex = *source.FileIndex
		fileLength = t.Files()[fileIndex].Length()
		completed = t.Files()[fileIndex].BytesCompleted()
	} else if file, index := torrentx.ChooseBestVideoFile(t); file != nil {
		fileIndex = index
		fileLength = file.Length()
		completed = file.BytesCompleted()
	} else {
		respondUnavailable("file_missing")
		return
	}

	stats := t.Stats()
	for fileLength > 0 && completed < fileLength && stats.ActivePeers == 0 {
		select {
		case <-ctx.Done():
			respondUnavailable("no_peers")
			return
		case <-time.After(250 * time.Millisecond):
			stats = t.Stats()
			completed = t.Files()[fileIndex].BytesCompleted()
		}
	}

	name := source.Name
	if name == "" {
		name = t.Name()
	}
	_ = json.NewEncoder(w).Encode(map[string]any{
		"playable":    true,
		"sourceUri":   source.URI,
		"sourceName":  name,
		"sourceKind":  kind,
		"fileIndex":   fileIndex,
		"activePeers": stats.ActivePeers,
		"cached":      fileLength > 0 && completed >= fileLength,
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

func (h *SessionHandlers) Ended(w http.ResponseWriter, r *http.Request) {
	var in struct {
		SeriesID, SeriesTitle, Kind string
		Season, Episode             int
		ProfileHash                 string
		EstRuntimeMin               float64
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	nextSeason, nextEp := in.Season, in.Episode+1
	p, err := torrentx.EnsurePick(r.Context(), h.d.Picks, torrentx.EnsureInput{
		SeriesID: in.SeriesID, SeriesTitle: in.SeriesTitle, Kind: in.Kind,
		Season: nextSeason, Episode: nextEp,
		ProfileHash: in.ProfileHash, EstRuntimeMin: in.EstRuntimeMin,
		ProfileCaps: h.d.ProfileCaps,
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
		"nextPick":   p,
		"streamUrl":  streamURL,
		"autoplayIn": 10,
	})
}

func (h *SessionHandlers) ResumeM3U(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	subject := strings.TrimSpace(q.Get("subjectId"))
	series := strings.TrimSpace(q.Get("seriesId"))
	kind := strings.TrimSpace(q.Get("kind"))         // movie|tv|anime
	title := strings.TrimSpace(q.Get("seriesTitle")) // optional, for display in players
	// optional hints (fallbacks if unknown)
	estRuntimeMin := 0.0
	if v := q.Get("estRuntimeMin"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			estRuntimeMin = float64(n)
		}
	}
	profileHash := q.Get("profileHash")
	subURL := strings.TrimSpace(q.Get("subUrl")) // optional: if you already have a subtitle URL

	if subject == "" || series == "" {
		http.Error(w, "subjectId & seriesId required", http.StatusBadRequest)
		return
	}
	if kind == "" {
		kind = "tv"
	}

	// 1) read last position & episode
	res, ok, err := h.d.Watch.GetResume(r.Context(), subject, series)
	if err != nil {
		http.Error(w, "db error", http.StatusInternalServerError)
		return
	}
	if !ok {
		http.Error(w, "no resume state", http.StatusNotFound)
		return
	}
	// Match the in-app resume behavior so external players get the same context.
	pos := rewindResumePosition(res.Position)

	// 2) ensure we have a pick for that S/E
	// if runtime/profile missing, apply safe defaults
	if estRuntimeMin <= 0 {
		if kind == "movie" {
			estRuntimeMin = 120
		} else {
			estRuntimeMin = 42
		}
	}
	if profileHash == "" {
		profileHash = "caps:h264|v1"
	}

	magnet := ""
	var fileIndex *int
	if source, found, sourceErr := h.d.Watch.GetProgressSource(r.Context(), subject, series, res.Season, res.Episode); sourceErr != nil {
		http.Error(w, "db error", http.StatusInternalServerError)
		return
	} else if found {
		magnet = source.URI
		fileIndex = source.FileIndex
		if source.Kind != "" {
			kind = source.Kind
		}
	}

	// Older progress rows do not have a source snapshot, so retain the pick
	// system as a compatibility fallback.
	if magnet == "" {
		p, pickErr := torrentx.EnsurePick(r.Context(), h.d.Picks, torrentx.EnsureInput{
			SeriesID: series, SeriesTitle: title, Kind: kind,
			Season: res.Season, Episode: res.Episode,
			ProfileHash: profileHash, EstRuntimeMin: estRuntimeMin,
			ProfileCaps: h.d.ProfileCaps,
		})
		if pickErr != nil {
			http.Error(w, "pick error: "+pickErr.Error(), http.StatusInternalServerError)
			return
		}
		magnet = p.Magnet
		if p.FileIndex != nil {
			value := *p.FileIndex
			fileIndex = &value
		}
	}

	// 3) build /stream URL (append cat so the right client pool is used)
	streamURL := "/stream?magnet=" + url.QueryEscape(magnet)
	if fileIndex != nil {
		streamURL += "&fileIndex=" + strconv.Itoa(*fileIndex)
	}
	streamURL += "&cat=" + url.QueryEscape(kind)

	// 4) (optional) guess a subtitle URL if none supplied; you will implement this later
	// expected future route: /subtitles/:episodeKey.vtt (you can change to .srt if you transcode)
	if subURL == "" {
		// simple, deterministic key for now — adjust to your final subtitle endpoint scheme
		subURL = fmt.Sprintf("/subtitles/%s_s%02de%02d.vtt", url.PathEscape(series), res.Season, res.Episode)
	}

	// 5) render M3U with VLC options
	name := title
	if name == "" {
		name = series
	}

	// NOTE: M3U is fine with \n newlines
	m3u := fmt.Sprintf(
		`#EXTM3U
#EXTINF:-1,%s — S%02dE%02d
#EXTVLCOPT:start-time=%d
#EXTVLCOPT:http-reconnect=true
#EXTVLCOPT:sub-file=%s
%s
`, name, res.Season, res.Episode, pos, subURL, streamURL)

	w.Header().Set("Content-Type", "audio/x-mpegurl")
	// a friendly filename
	base := strings.NewReplacer(":", "_", "/", "_").Replace(series)
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"resume_%s_s%02de%02d.m3u\"", base, res.Season, res.Episode))
	_, _ = w.Write([]byte(m3u))
}
