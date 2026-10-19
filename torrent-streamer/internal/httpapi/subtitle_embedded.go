package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log"
	"net/http"
	"strconv"
	"sync"
	"time"

	"torrent-streamer/internal/downloads"
	"torrent-streamer/internal/middleware"
)

// GET /subtitles/embedded?track=N&(downloadId&clientId | magnet&fileIndex&cat)
// returns a video's own Nth subtitle track (container order, as players list
// them) as WebVTT, so the app draws a torrent's subtitles exactly like the
// ones it downloads (one look everywhere). Subtitles are interleaved through
// the file, so the server reads the whole video through its own /stream:
// the first ask answers "pending" and the result is kept.
//
// The answer is {status: "ready"|"pending"|"none", reason, url}; "none"
// with reason "styled" is an ASS/SSA track the player keeps drawing (its
// positioned signs would be lost as plain text).

const (
	embeddedTimeout   = 20 * time.Minute // a download whose server copy is gone is read from the torrent again
	embeddedReadyTTL  = 24 * time.Hour
	embeddedNoneTTL   = 6 * time.Hour
	embeddedErrorTTL  = 2 * time.Minute
	embeddedMaxCached = 200
)

type embeddedEntry struct {
	done   chan struct{}
	status string // ready, none (after done)
	reason string
	data   []byte
	at     time.Time
	ttl    time.Duration
}

var embeddedCache = struct {
	sync.Mutex
	entries map[string]*embeddedEntry
}{entries: map[string]*embeddedEntry{}}

func (h SubtitleMatchHandlers) handleEmbedded(w http.ResponseWriter, r *http.Request) {
	middleware.EnableCORS(w)
	if r.Method == http.MethodOptions {
		return
	}
	q := r.URL.Query()
	track, err := strconv.Atoi(q.Get("track"))
	if err != nil || track < 0 || track > 64 {
		http.Error(w, "track is required", http.StatusBadRequest)
		return
	}
	source, err := h.resolve(r.Context(), q, "en")
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"status": "none", "reason": "unknown video"})
		return
	}
	sum := sha256.Sum256([]byte("embedded\x00" + canonicalMagnetHash(source.magnet) + "\x00" + strconv.Itoa(source.fileIndex) + "\x00" + strconv.Itoa(track)))
	key := hex.EncodeToString(sum[:12])
	entry := h.embeddedEntryFor(key, source, track)
	select {
	case <-entry.done:
	case <-time.After(matchQuickWait):
	case <-r.Context().Done():
		return
	}
	writeJSON(w, http.StatusOK, entry.response(key))
}

func (h SubtitleMatchHandlers) embeddedEntryFor(key string, source matchSource, track int) *embeddedEntry {
	embeddedCache.Lock()
	defer embeddedCache.Unlock()
	if entry, ok := embeddedCache.entries[key]; ok {
		select {
		case <-entry.done:
			if time.Since(entry.at) < entry.ttl {
				return entry
			}
		default:
			return entry // still reading
		}
	}
	if len(embeddedCache.entries) >= embeddedMaxCached {
		var oldestKey string
		var oldest time.Time
		for candidate, entry := range embeddedCache.entries {
			select {
			case <-entry.done:
				if oldestKey == "" || entry.at.Before(oldest) {
					oldestKey, oldest = candidate, entry.at
				}
			default:
			}
		}
		if oldestKey != "" {
			delete(embeddedCache.entries, oldestKey)
		}
	}
	entry := &embeddedEntry{done: make(chan struct{})}
	embeddedCache.entries[key] = entry
	infoHash := canonicalMagnetHash(source.magnet)
	if data, ok := downloads.SavedOwnTrack(infoHash, source.fileIndex, track); ok {
		// Read when its download was prepared (or by an earlier play).
		entry.status, entry.data, entry.ttl, entry.at = "ready", data, embeddedReadyTTL, time.Now()
		close(entry.done)
		return entry
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), embeddedTimeout)
		defer cancel()
		data, info, err := downloads.ExtractSubtitleTrack(ctx, h.streamURL(source), track)
		entry.at = time.Now()
		switch {
		case err == nil:
			entry.status, entry.data, entry.ttl = "ready", data, embeddedReadyTTL
			if saveErr := downloads.SaveOwnTrack(infoHash, source.fileIndex, track, data); saveErr != nil {
				log.Printf("[subtitles] could not keep own track %d of %s#%d: %v", track, infoHash, source.fileIndex, saveErr)
			}
		case errors.Is(err, downloads.ErrStyledSubtitle):
			entry.status, entry.reason, entry.ttl = "none", "styled", embeddedNoneTTL
		default:
			log.Printf("[subtitles] own track %d of %s#%d (%s): %v", track, canonicalMagnetHash(source.magnet), source.fileIndex, info.Codec, err)
			entry.status, entry.reason, entry.ttl = "none", "unavailable", embeddedErrorTTL
		}
		close(entry.done)
	}()
	return entry
}

func (entry *embeddedEntry) response(key string) map[string]any {
	select {
	case <-entry.done:
	default:
		return map[string]any{"status": "pending"}
	}
	if entry.status != "ready" {
		return map[string]any{"status": "none", "reason": entry.reason}
	}
	return map[string]any{"status": "ready", "url": "/subtitles/embedded/file?key=" + key}
}

func handleEmbeddedFile(w http.ResponseWriter, r *http.Request) {
	middleware.EnableCORS(w)
	if r.Method == http.MethodOptions {
		return
	}
	embeddedCache.Lock()
	entry, ok := embeddedCache.entries[r.URL.Query().Get("key")]
	embeddedCache.Unlock()
	if !ok {
		http.NotFound(w, r)
		return
	}
	select {
	case <-entry.done:
	default:
		http.Error(w, "still reading", http.StatusConflict)
		return
	}
	if entry.status != "ready" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/vtt; charset=utf-8")
	w.Header().Set("Cache-Control", "private, max-age=3600")
	_, _ = w.Write(entry.data)
}
