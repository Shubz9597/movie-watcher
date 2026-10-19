package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"log"
	"net/http"
	"strconv"
	"sync"
	"time"

	"torrent-streamer/internal/downloads"
	"torrent-streamer/internal/middleware"
)

// GET /media/tracks?(downloadId&clientId | magnet&fileIndex&cat) lists a
// video's own audio and subtitle tracks in container order, so the desktop
// player (mpv numbers them the same way) names and picks them like the
// phone. The header of a torrent can take a while to arrive: the first ask
// answers "pending" and the result is kept.
//
// The answer is {status: "ready"|"pending"|"none", audio, subtitles}.

const (
	tracksTimeout   = 3 * time.Minute
	tracksReadyTTL  = 24 * time.Hour
	tracksErrorTTL  = 2 * time.Minute
	tracksMaxCached = 300
)

type tracksEntry struct {
	done   chan struct{}
	tracks downloads.MediaTracks
	failed bool
	at     time.Time
}

var tracksCache = struct {
	sync.Mutex
	entries map[string]*tracksEntry
}{entries: map[string]*tracksEntry{}}

// probeTracks is replaced in tests.
var probeTracks = downloads.ProbeMediaTracks

func (h SubtitleMatchHandlers) handleTracks(w http.ResponseWriter, r *http.Request) {
	middleware.EnableCORS(w)
	if r.Method == http.MethodOptions {
		return
	}
	source, err := h.resolve(r.Context(), r.URL.Query(), "en")
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"status": "none"})
		return
	}
	sum := sha256.Sum256([]byte("tracks\x00" + canonicalMagnetHash(source.magnet) + "\x00" + strconv.Itoa(source.fileIndex)))
	entry := h.tracksEntryFor(hex.EncodeToString(sum[:12]), source)
	select {
	case <-entry.done:
	case <-time.After(matchQuickWait):
	case <-r.Context().Done():
		return
	}
	writeJSON(w, http.StatusOK, entry.response())
}

func (h SubtitleMatchHandlers) tracksEntryFor(key string, source matchSource) *tracksEntry {
	tracksCache.Lock()
	defer tracksCache.Unlock()
	if entry, ok := tracksCache.entries[key]; ok {
		select {
		case <-entry.done:
			ttl := tracksReadyTTL
			if entry.failed {
				ttl = tracksErrorTTL
			}
			if time.Since(entry.at) < ttl {
				return entry
			}
		default:
			return entry // still reading
		}
	}
	if len(tracksCache.entries) >= tracksMaxCached {
		for candidate, entry := range tracksCache.entries {
			select {
			case <-entry.done:
				delete(tracksCache.entries, candidate)
			default:
			}
			if len(tracksCache.entries) < tracksMaxCached {
				break
			}
		}
	}
	entry := &tracksEntry{done: make(chan struct{})}
	tracksCache.entries[key] = entry
	go func() {
		tracks, err := probeTracks(context.Background(), h.streamURL(source), tracksTimeout)
		entry.at = time.Now()
		if err != nil {
			log.Printf("[tracks] %s#%d: %v", canonicalMagnetHash(source.magnet), source.fileIndex, err)
			entry.failed = true
		} else {
			entry.tracks = tracks
		}
		close(entry.done)
	}()
	return entry
}

func (entry *tracksEntry) response() map[string]any {
	select {
	case <-entry.done:
	default:
		return map[string]any{"status": "pending"}
	}
	if entry.failed {
		return map[string]any{"status": "none"}
	}
	return map[string]any{"status": "ready", "audio": entry.tracks.Audio, "subtitles": entry.tracks.Subtitles}
}
