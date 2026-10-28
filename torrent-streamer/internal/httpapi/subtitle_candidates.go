package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"torrent-streamer/internal/downloads"
	"torrent-streamer/internal/middleware"
	"torrent-streamer/internal/subsync"
	"torrent-streamer/internal/transcribe"
)

// GET /subtitles/candidates?downloadId&clientId&lang lists the online
// subtitles for a download's episode, each measured against the video's
// audio in that language (when the video is still on this server) and moved
// onto its dialogue, best fit first. The phone shows them when the packaged
// subtitle is wrong and keeps the one picked with the download.
//
// For a dub (English audio beside another language) the first track is
// written from the English audio itself (internal/transcribe) and every
// track says how many of its words the audio shares ("words"): online
// English subtitles usually translate the original language instead.
// Transcribing takes about two minutes: until then the answer is
// {status: "pending"} and the phone asks again.
//
// {status, measured, message, tracks: [{id, label, fit, offset, follows, words, url}]}

const (
	candidateLimit     = 12
	candidateTimeout   = 25 * time.Minute // a transcript may wait for others
	candidateWait      = 20 * time.Second
	candidateTTL       = time.Hour
	candidateErrorTTL  = 2 * time.Minute
	candidateMaxCached = 40
	// candidateSeconds of audio are measured: ten minutes hold enough lines
	// to rank a handful of subtitles (30 took ~10 s of the wait).
	candidateSeconds = 10 * 60
)

type candidateEntry struct {
	done  chan struct{}
	at    time.Time
	ttl   time.Duration
	body  map[string]any
	files [][]byte
}

var candidateCache = struct {
	sync.Mutex
	entries map[string]*candidateEntry
}{entries: map[string]*candidateEntry{}}

func (h SubtitleMatchHandlers) handleCandidates(w http.ResponseWriter, r *http.Request) {
	middleware.EnableCORS(w)
	if r.Method == http.MethodOptions {
		return
	}
	q := r.URL.Query()
	lang := strings.ToLower(strings.TrimSpace(q.Get("lang")))
	if lang == "" {
		lang = "en"
	}
	if !subtitleLanguagePattern.MatchString(lang) {
		http.Error(w, "invalid subtitle language", http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(q.Get("downloadId")) == "" {
		http.Error(w, "downloadId is required", http.StatusBadRequest)
		return
	}
	source, err := h.resolve(r.Context(), q, lang)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"tracks": []any{}, "message": "This download is not on the server."})
		return
	}
	sum := sha256.Sum256([]byte(q.Get("downloadId") + "\x00" + lang))
	key := hex.EncodeToString(sum[:12])
	entry := candidateEntryFor(key, source, lang)
	select {
	case <-entry.done:
		writeJSON(w, http.StatusOK, entry.body)
	case <-time.After(candidateWait):
		writeJSON(w, http.StatusOK, map[string]any{"status": "pending", "tracks": []any{},
			"message": "Writing subtitles from the English audio… this takes about two minutes."})
	case <-r.Context().Done():
	}
}

func candidateEntryFor(key string, source matchSource, lang string) *candidateEntry {
	candidateCache.Lock()
	defer candidateCache.Unlock()
	if entry, ok := candidateCache.entries[key]; ok {
		select {
		case <-entry.done:
			if time.Since(entry.at) < entry.ttl {
				return entry
			}
		default:
			return entry // still working
		}
	}
	if len(candidateCache.entries) >= candidateMaxCached {
		var oldestKey string
		var oldest time.Time
		for k, e := range candidateCache.entries {
			select {
			case <-e.done:
				if oldestKey == "" || e.at.Before(oldest) {
					oldestKey, oldest = k, e.at
				}
			default:
			}
		}
		if oldestKey != "" {
			delete(candidateCache.entries, oldestKey)
		}
	}
	entry := &candidateEntry{done: make(chan struct{})}
	candidateCache.entries[key] = entry
	go scoreCandidates(entry, key, source, lang)
	return entry
}

func scoreCandidates(entry *candidateEntry, key string, source matchSource, lang string) {
	ctx, cancel := context.WithTimeout(context.Background(), candidateTimeout)
	defer cancel()
	finish := func(body map[string]any, files [][]byte, ttl time.Duration) {
		entry.body, entry.files, entry.ttl, entry.at = body, files, ttl, time.Now()
		close(entry.done)
	}
	candidates, err := DownloadSubtitleSource{}.fetchCandidatesOnce(ctx, source.query, candidateLimit)
	message, ttl := "", candidateTTL
	if err != nil {
		message, ttl = "Online subtitles could not be listed right now.", candidateErrorTTL
		if errors.Is(err, downloads.ErrSubtitleNotFound) {
			message, ttl = "No online subtitles for this episode.", candidateTTL
		}
		log.Printf("[subtitles] candidates for %s S%dE%d (%s): %v", source.query.SeriesID, source.query.Season, source.query.Episode, lang, err)
		candidates = nil // a dub's own words may still be written below
	}
	var transcript []transcribe.Word
	if source.file != "" && lang == "en" {
		texts := make([]string, 0, len(candidates))
		for _, candidate := range candidates {
			texts = append(texts, string(candidate.Data))
		}
		transcript, _ = downloads.DubTranscript(ctx, source.jobID, source.file, source.query.Hints.Title, texts)
	}
	var scored []downloads.Scored
	measured := false
	if source.file != "" {
		if scored, err = downloads.ScoreToAudio(ctx, source.file, lang, candidateSeconds, candidates); err == nil {
			measured = true
		} else {
			log.Printf("[subtitles] candidates for %s S%dE%d not measured: %v", source.query.SeriesID, source.query.Season, source.query.Episode, err)
		}
	}
	if !measured && len(candidates) > 0 {
		// The video is gone from the server (or unreadable): as published.
		scored = scored[:0]
		for _, candidate := range candidates {
			scored = append(scored, downloads.Scored{Name: candidate.Name, Label: candidate.Label, Data: candidate.Data})
		}
	}
	tracks := make([]map[string]any, 0, len(scored)+1)
	files := make([][]byte, 0, len(scored)+1)
	add := func(track map[string]any, data []byte) {
		track["url"] = "/subtitles/candidates/file?key=" + key + "&i=" + strconv.Itoa(len(files))
		tracks = append(tracks, track)
		files = append(files, data)
	}
	if len(transcript) > 0 {
		add(map[string]any{
			"id": "transcript", "label": "From the English audio", "transcript": true,
			"fit": 1.0, "offset": 0.0, "follows": true, "words": 1.0,
		}, []byte(transcribe.WebVTT(transcribe.Cues(transcript), subsync.DubNote)))
	}
	for _, item := range scored {
		track := map[string]any{"id": item.Name, "label": item.Label, "fit": item.Fit, "offset": item.Offset, "follows": item.Follows}
		if len(transcript) > 0 {
			track["words"] = transcribe.WordMatch(transcript, string(item.Data))
		}
		add(track, item.Data)
	}
	log.Printf("[subtitles] %d %s candidates for %s S%dE%d (measured %v)", len(tracks), lang, source.query.SeriesID, source.query.Season, source.query.Episode, measured)
	finish(map[string]any{"status": "ready", "tracks": tracks, "measured": measured, "message": message}, files, ttl)
}

func handleCandidateFile(w http.ResponseWriter, r *http.Request) {
	middleware.EnableCORS(w)
	if r.Method == http.MethodOptions {
		return
	}
	q := r.URL.Query()
	index, err := strconv.Atoi(q.Get("i"))
	candidateCache.Lock()
	entry, ok := candidateCache.entries[q.Get("key")]
	candidateCache.Unlock()
	if !ok || err != nil {
		http.NotFound(w, r)
		return
	}
	select {
	case <-entry.done:
	default:
		http.Error(w, "still listing", http.StatusConflict)
		return
	}
	if index < 0 || index >= len(entry.files) {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/vtt; charset=utf-8")
	w.Header().Set("Cache-Control", "private, max-age=3600")
	_, _ = w.Write(entry.files[index])
}
