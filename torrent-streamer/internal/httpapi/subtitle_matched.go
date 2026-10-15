package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"torrent-streamer/internal/downloads"
	"torrent-streamer/internal/middleware"
	"torrent-streamer/internal/torrentx"
)

// SubtitleMatchHandlers serves the online subtitle that follows a video's
// audio in one language, moved onto its dialogue (GET /subtitles/matched).
// Streams and downloads prepared before matching existed use it: the
// server measures the first minutes of the video through its own /stream
// and keeps the result. For a dual-audio video in that language the match
// is the dub's script (Dragon Ball Z Kai: English dub captions, 4 s late as
// published).
//
// The answer is {status: "ready"|"pending"|"none", lang, dub, offset, fit,
// url}. "pending" means the measurement runs in the background; ask again.
type SubtitleMatchHandlers struct {
	Jobs       *downloads.Store
	Picks      *torrentx.Repo
	ListenAddr string // this server's /stream, read through loopback
}

const (
	// matchSeconds of a stream are measured: the offset of a release is the
	// same throughout, and five minutes hold enough lines to tell.
	matchSeconds   = 5 * 60
	matchTimeout   = 4 * time.Minute
	matchQuickWait = 1500 * time.Millisecond
	matchReadyTTL  = 24 * time.Hour
	matchNoneTTL   = 6 * time.Hour
	matchErrorTTL  = 2 * time.Minute
	matchMaxCached = 300
)

type matchEntry struct {
	done    chan struct{}
	status  string // ready, none (after done)
	matched downloads.Matched
	lang    string
	at      time.Time
	ttl     time.Duration
}

var matchCache = struct {
	sync.Mutex
	entries map[string]*matchEntry
}{entries: map[string]*matchEntry{}}

func (h SubtitleMatchHandlers) Register(mux *http.ServeMux) {
	mux.HandleFunc("/subtitles/matched", h.handleMatched)
	mux.HandleFunc("/subtitles/matched/file", handleMatchedFile)
	mux.HandleFunc("/subtitles/embedded", h.handleEmbedded)
	mux.HandleFunc("/subtitles/embedded/file", handleEmbeddedFile)
}

// matchSource is the video and the subtitle search for one request.
type matchSource struct {
	cat, magnet string
	fileIndex   int
	query       downloads.SubtitleQuery
}

func (h SubtitleMatchHandlers) handleMatched(w http.ResponseWriter, r *http.Request) {
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
	source, err := h.resolve(r.Context(), q, lang)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"status": "none", "lang": lang})
		return
	}
	key := matchKey(source, lang)
	entry := h.entryFor(key, source, lang)
	select {
	case <-entry.done:
	case <-time.After(matchQuickWait):
	case <-r.Context().Done():
		return
	}
	writeJSON(w, http.StatusOK, entry.response(key))
}

// resolve finds the video: a download by its job (scoped to the device that
// owns it), else a stream's magnet and file index with search hints.
func (h SubtitleMatchHandlers) resolve(ctx context.Context, q url.Values, lang string) (matchSource, error) {
	if jobID := strings.TrimSpace(q.Get("downloadId")); jobID != "" {
		if h.Jobs == nil || h.Picks == nil {
			return matchSource{}, errors.New("downloads unavailable")
		}
		job, err := h.Jobs.Get(ctx, strings.TrimSpace(q.Get("clientId")), jobID)
		if err != nil {
			return matchSource{}, err
		}
		pick, ok, err := h.Picks.GetPickByID(ctx, job.PickID)
		if err != nil || !ok {
			return matchSource{}, errors.New("source unavailable")
		}
		if pick.FileIndex == nil {
			return matchSource{}, errors.New("source file unknown")
		}
		return matchSource{
			cat: torrentx.Category(pick.SourceKind), magnet: pick.Magnet, fileIndex: *pick.FileIndex,
			query: downloads.SubtitleQuery{
				SeriesID: job.SeriesID, Season: job.Season, Episode: job.Episode, Lang: lang,
				Hints: job.SubtitleHints,
			},
		}, nil
	}
	magnet := strings.TrimSpace(q.Get("magnet"))
	fileIndex, err := strconv.Atoi(q.Get("fileIndex"))
	if magnet == "" || err != nil || fileIndex < 0 {
		return matchSource{}, errors.New("a download or a magnet and file index is required")
	}
	query := downloads.SubtitleQuery{
		Lang: lang, Season: intParam(q, "season"), Episode: intParam(q, "episode"),
		VideoName: magnetDisplayName(magnet),
		Hints:     downloads.SubtitleHints{IMDBID: q.Get("imdbId"), Title: q.Get("title"), Year: intParam(q, "year")},
	}
	switch {
	case q.Get("anilistId") != "":
		query.SeriesID = "anilist:" + q.Get("anilistId")
	case q.Get("tmdbId") != "" && parseCat(q) == "movie":
		query.SeriesID = "tmdb:movie:" + q.Get("tmdbId")
	case q.Get("tmdbId") != "":
		query.SeriesID = "tmdb:tv:" + q.Get("tmdbId")
	}
	return matchSource{cat: parseCat(q), magnet: magnet, fileIndex: fileIndex, query: query}, nil
}

func matchKey(source matchSource, lang string) string {
	sum := sha256.Sum256([]byte(canonicalMagnetHash(source.magnet) + "\x00" + strconv.Itoa(source.fileIndex) + "\x00" + lang))
	return hex.EncodeToString(sum[:12])
}

// canonicalMagnetHash keys a source by its info hash (trackers and names in
// the magnet vary between requests).
func canonicalMagnetHash(magnet string) string {
	if parsed, err := url.Parse(magnet); err == nil {
		for _, xt := range parsed.Query()["xt"] {
			if strings.HasPrefix(strings.ToLower(xt), "urn:btih:") {
				return strings.ToLower(xt[len("urn:btih:"):])
			}
		}
	}
	return magnet
}

// entryFor returns the cached or running measurement, starting one if none.
func (h SubtitleMatchHandlers) entryFor(key string, source matchSource, lang string) *matchEntry {
	matchCache.Lock()
	defer matchCache.Unlock()
	if entry, ok := matchCache.entries[key]; ok {
		select {
		case <-entry.done:
			if time.Since(entry.at) < entry.ttl {
				return entry
			}
		default:
			return entry // still measuring
		}
	}
	if len(matchCache.entries) >= matchMaxCached {
		evictOldestMatch()
	}
	entry := &matchEntry{done: make(chan struct{}), lang: lang}
	matchCache.entries[key] = entry
	go h.measure(entry, source, lang)
	return entry
}

func evictOldestMatch() {
	var oldestKey string
	var oldest time.Time
	for key, entry := range matchCache.entries {
		select {
		case <-entry.done:
		default:
			continue
		}
		if oldestKey == "" || entry.at.Before(oldest) {
			oldestKey, oldest = key, entry.at
		}
	}
	if oldestKey != "" {
		delete(matchCache.entries, oldestKey)
	}
}

func (h SubtitleMatchHandlers) measure(entry *matchEntry, source matchSource, lang string) {
	ctx, cancel := context.WithTimeout(context.Background(), matchTimeout)
	defer cancel()
	finish := func(status string, matched downloads.Matched, ttl time.Duration) {
		entry.status, entry.matched, entry.ttl, entry.at = status, matched, ttl, time.Now()
		close(entry.done)
	}
	candidates, err := DownloadSubtitleSource{}.fetchCandidatesOnce(ctx, source.query, 6)
	if err != nil {
		ttl := matchErrorTTL
		if errors.Is(err, downloads.ErrSubtitleNotFound) {
			ttl = matchNoneTTL
		}
		finish("none", downloads.Matched{}, ttl)
		return
	}
	stream := h.streamURL(source)
	own, _ := downloads.EmbeddedSubtitleWindow(ctx, stream, lang, matchSeconds)
	matched, err := downloads.MatchToAudio(ctx, stream, lang, matchSeconds, own, candidates)
	switch {
	case err == nil:
		log.Printf("[subtitles] matched %s subtitle for %s#%d: %s", lang, canonicalMagnetHash(source.magnet), source.fileIndex, matched.Why)
		finish("ready", matched, matchReadyTTL)
	case errors.Is(err, downloads.ErrNoMatch):
		finish("none", downloads.Matched{}, matchNoneTTL)
	default:
		log.Printf("[subtitles] matching %s subtitle for %s#%d failed: %v", lang, canonicalMagnetHash(source.magnet), source.fileIndex, err)
		finish("none", downloads.Matched{}, matchErrorTTL)
	}
}

// streamURL reads the video through this server's own /stream, which
// fetches and prioritises the torrent's pieces as playback does.
func (h SubtitleMatchHandlers) streamURL(source matchSource) string {
	port := "8080"
	if _, p, err := net.SplitHostPort(h.ListenAddr); err == nil && p != "" {
		port = p
	}
	params := url.Values{"cat": {source.cat}, "fileIndex": {strconv.Itoa(source.fileIndex)}, "magnet": {source.magnet}}
	return "http://127.0.0.1:" + port + "/stream?" + params.Encode()
}

func (entry *matchEntry) response(key string) map[string]any {
	select {
	case <-entry.done:
	default:
		return map[string]any{"status": "pending", "lang": entry.lang}
	}
	if entry.status != "ready" {
		return map[string]any{"status": "none", "lang": entry.lang}
	}
	return map[string]any{
		"status": "ready", "lang": entry.lang, "dub": entry.matched.Dub,
		"offset": entry.matched.Offset, "fit": entry.matched.Fit,
		"url": "/subtitles/matched/file?key=" + key,
	}
}

func handleMatchedFile(w http.ResponseWriter, r *http.Request) {
	middleware.EnableCORS(w)
	if r.Method == http.MethodOptions {
		return
	}
	key := r.URL.Query().Get("key")
	matchCache.Lock()
	entry, ok := matchCache.entries[key]
	matchCache.Unlock()
	if !ok {
		http.NotFound(w, r)
		return
	}
	select {
	case <-entry.done:
	default:
		http.Error(w, "still matching", http.StatusConflict)
		return
	}
	if entry.status != "ready" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/vtt; charset=utf-8")
	w.Header().Set("Cache-Control", "private, max-age=3600")
	_, _ = w.Write(entry.matched.Data)
}
