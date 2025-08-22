package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime/debug"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/anacrolix/torrent"
	"github.com/anacrolix/torrent/metainfo"
	"github.com/joho/godotenv"

	"torrent-streamer/internal/logx"
	"torrent-streamer/internal/watch"
)

/* =========================
   Types
   ========================= */

type fileEntry struct {
	Index  int    `json:"index"`
	Name   string `json:"name"`
	Length int64  `json:"length"`
}
type addResp struct {
	InfoHash string      `json:"infoHash"`
	Name     string      `json:"name"`
	Files    []fileEntry `json:"files"`
}
type prefetchResp struct {
	InfoHash       string      `json:"infoHash"`
	Name           string      `json:"name"`
	FileIndex      int         `json:"fileIndex"`
	FileName       string      `json:"fileName"`
	FileLength     int64       `json:"fileLength"`
	MetadataMs     int64       `json:"metadataMs"`
	PrebufferBytes int64       `json:"prebufferBytes"`
	PrebufferMs    int64       `json:"prebufferMs"`
	Note           string      `json:"note"`
	Files          []fileEntry `json:"files,omitempty"`
}

type torrentStat struct {
	InfoHash      string `json:"infoHash"`
	Name          string `json:"name"`
	HaveInfo      bool   `json:"haveInfo"`
	Size          int64  `json:"size"` // total length (0 if unknown)
	NumFiles      int    `json:"numFiles"`
	BestIndex     int    `json:"bestIndex"` // -1 if none
	BestName      string `json:"bestName"`
	BestLength    int64  `json:"bestLength"`
	SelectedIndex *int   `json:"selectedIndex,omitempty"` // last streamed file index if known
	LastTouched   string `json:"lastTouched"`             // RFC3339 or "never"
	BufferedAhead int64  `json:"bufferedAhead"`           // probe from bestIdx + playhead
	TargetAhead   int64  `json:"targetAhead"`
}

type categoryStats struct {
	Category string        `json:"category"`
	Torrents []torrentStat `json:"torrents"`
}

type statsResp struct {
	UptimeSeconds   int64           `json:"uptimeSeconds"`
	DataRoot        string          `json:"dataRoot"`
	TotalCacheBytes int64           `json:"totalCacheBytes"`
	CacheMaxBytes   int64           `json:"cacheMaxBytes"`
	EvictTTL        string          `json:"evictTTL"`
	TrackersMode    string          `json:"trackersMode"`
	Categories      []categoryStats `json:"categories"`
}

type urlQ interface{ Get(string) string }

type bufferInfoOut struct {
	State           string `json:"state"`
	PlayheadBytes   int64  `json:"playheadBytes"`
	TargetBytes     int64  `json:"targetBytes"`
	TargetAheadSec  int64  `json:"targetAheadSec"`
	RollingBps      int64  `json:"rollingBps"`
	ContiguousAhead int64  `json:"contiguousAhead"`
	FileIndex       int    `json:"fileIndex"`
	FileLength      int64  `json:"fileLength"`
}

/* =========================
   Env & globals
   ========================= */

var (
	dataRoot  string
	cacheMax  int64
	evictTTL  time.Duration
	clientsMu sync.Mutex
	clients   = make(map[string]*torrent.Client) // cat -> client
	lastTouch = make(map[string]time.Time)       // key(cat:infohash) -> time

	// Tunables
	waitMetadata = 25 * time.Second
	prebufferN   = int64(1 << 20) // 1 MiB default
	prebufferTO  = 15 * time.Second

	// Trackers behavior: "all" | "http" | "udp" | "none"
	trackersMode = "all"

	// logging
	logFilePath = "debug.log"

	startTime     = time.Now()
	lastFileIndex = make(map[string]int) // key(cat:infohash) -> last streamed file index

	// --- Buffering tunables (seconds/MB) ---
	targetPlaySec     = int64(90)             // keep ~90s ahead while playing
	targetPauseSec    = int64(360)            // fill ~6m ahead while paused
	warmReadAheadMB   = int64(16)             // internal warm-up read per request
	enableEndgameDup  = true                  // duplicate final 5% requests in window
	defaultBitrateBps = int64(24_000_000 / 8) // 3 MB/s fallback (~24 Mbps)
	// serialize prefetch per file to avoid thrash/lock contention
	prefetchLocks sync.Map // key string -> *sync.Mutex

	// Optional, read from env at boot (see main)
	targetPlay4KSec   int64 // default 180 if env missing
	targetPause4KSec  int64 // default 600 if env missing
	warmReadAhead4KMB int64 // default 64 (or env)
)

func setupLogging() {
	var out io.Writer = os.Stdout

	if p := os.Getenv("LOG_FILE"); p != "" {
		f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
		if err != nil {
			log.Printf("WARN opening LOG_FILE=%q: %v", p, err)
		} else {
			out = io.MultiWriter(os.Stdout, f)
		}
	}

	// Allow ONLY our tagged lines; drop noisy library spew.
	// Tweak LOG_ALLOW to your taste (adds or removes tags).
	allow := getenvDefault("LOG_ALLOW",
		`^\[(init|add|files|prefetch|stream|watch|janitor|stats|trackers)\]`)

	// Hide Windows flush/fsync messages and similar low-level churn.
	deny := getenvDefault("LOG_DENY",
		`FlushFileBuffers|fsync|WriteFile|The handle is invalid|Access is denied|Permission denied`)

	// De-dup window (identical lines within this time are dropped).
	window := getenvDuration("LOG_DEDUP_WINDOW", 2*time.Second)

	filter := logx.New(out, window, allow, deny)
	log.SetOutput(filter)

	log.Printf("[init] logging configured (dedup=%s allow=%q deny=%q)", window, allow, deny)
}

// sanitizeMagnet: optionally filter trackers from a magnet string.
// TRACKERS_MODE values:
//
//	"udp"  -> keep only udp:// trackers
//	"any"  -> keep all except known Cloudflare-protected hosts
//	"none" -> remove all trackers (DHT only)
func sanitizeMagnet(raw string) string {
	if !strings.HasPrefix(raw, "magnet:") {
		return raw
	}
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	q := u.Query()

	mode := strings.ToLower(strings.TrimSpace(os.Getenv("TRACKERS_MODE")))
	if mode == "" {
		mode = "udp" // sensible default
	}

	// Pull original trackers
	orig := q["tr"]
	q.Del("tr")

	keep := func(tr string) bool {
		trL := strings.ToLower(tr)
		switch mode {
		case "udp":
			return strings.HasPrefix(trL, "udp://")
		case "none":
			return false
		default: // "any"
			// Drop Cloudflare-protected renfei trackers (very noisy 403s)
			if strings.Contains(trL, "tracker.renfei.net") || strings.Contains(trL, "renfei.eu.org") {
				return false
			}
			return true
		}
	}

	for _, tr := range orig {
		if keep(tr) {
			q.Add("tr", tr)
		}
	}
	u.RawQuery = q.Encode()
	return u.String()
}

// for log context only
func countTrackers(raw string) (udp, http, https, other int) {
	u, err := url.Parse(raw)
	if err != nil {
		return
	}
	for _, tr := range u.Query()["tr"] {
		if strings.HasPrefix(strings.ToLower(tr), "udp://") {
			udp++
		} else if strings.HasPrefix(strings.ToLower(tr), "http://") {
			http++
		} else if strings.HasPrefix(strings.ToLower(tr), "https://") {
			https++
		} else {
			other++
		}
	}
	return
}

func getenvDefault(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
func getenvInt64(k string, def int64) int64 {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			return n
		}
	}
	return def
}
func getenvDuration(k string, def time.Duration) time.Duration {
	if v := os.Getenv(k); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return def
}
func key(cat string, ih metainfo.Hash) string { return cat + ":" + ih.HexString() }

/* =========================
   Trackers (optional extras)
   ========================= */

var extraHTTP = []string{
	"http://tracker.opentrackr.org:1337/announce",
	"https://tracker.opentrackr.org:443/announce",
	"https://opentracker.i2p.rocks:443/announce",
	"https://tracker.zemoj.com/announce",
}
var extraUDP = []string{
	"udp://tracker.opentrackr.org:1337/announce",
	"udp://open.stealth.si:80/announce",
	"udp://tracker.torrent.eu.org:451/announce",
	"udp://exodus.desync.com:6969/announce",
	"udp://open.demonii.com:1337/announce",
}

func buildTrackerTiers() [][]string {
	var tiers [][]string
	switch trackersMode {
	case "none":
		return tiers
	case "http":
		for _, s := range extraHTTP {
			tiers = append(tiers, []string{s})
		}
	case "udp":
		for _, s := range extraUDP {
			tiers = append(tiers, []string{s})
		}
	default: // "all"
		for _, s := range extraHTTP {
			tiers = append(tiers, []string{s})
		}
		for _, s := range extraUDP {
			tiers = append(tiers, []string{s})
		}
	}
	return tiers
}

/* =========================
   client per-category
   ========================= */

func validCat(c string) string {
	c = strings.ToLower(strings.TrimSpace(c))
	switch c {
	case "movie", "tv", "anime":
		return c
	case "":
		return "misc"
	default:
		return c
	}
}

func getClientFor(cat string) *torrent.Client {
	cat = validCat(cat)
	clientsMu.Lock()
	defer clientsMu.Unlock()

	if c, ok := clients[cat]; ok {
		return c
	}
	dir := filepath.Join(dataRoot, cat)
	_ = os.MkdirAll(dir, 0o755)

	// ✅ Make DataDir Windows-safe (short and long-path enabled)
	dir = winLongPath(dir)

	cfg := torrent.NewDefaultClientConfig()
	cfg.DataDir = dir
	cfg.DisableTCP = false
	cfg.DisableUTP = false
	cfg.Seed = false
	cfg.NoUpload = false

	c, err := torrent.NewClient(cfg)
	if err != nil {
		log.Fatalf("client(%s) init: %v", cat, err)
	}
	clients[cat] = c
	log.Printf("[init] client(%s) dataDir=%s trackersMode=%s", cat, dir, trackersMode)
	return c
}

/* =========================
   helpers
   ========================= */

func parseCat(q urlQ) string { return validCat(q.Get("cat")) }

func parseSrc(q urlQ) (string, error) {
	if s := q.Get("magnet"); s != "" {
		return sanitizeMagnet(s), nil
	}
	if s := q.Get("src"); s != "" {
		if strings.HasPrefix(s, "magnet:") {
			return sanitizeMagnet(s), nil
		}
		return s, nil
	}
	if ih := strings.TrimSpace(q.Get("infoHash")); ih != "" {
		if len(ih) == 40 || len(ih) == 32 {
			return sanitizeMagnet("magnet:?xt=urn:btih:" + strings.ToUpper(ih)), nil
		}
	}
	return "", errors.New("missing magnet/src/infoHash")
}

func mustParseMagnet(src string) metainfo.Hash {
	if strings.HasPrefix(src, "magnet:") {
		m, err := metainfo.ParseMagnetURI(src) // deprecated but present in your version
		if err == nil && m.InfoHash != (metainfo.Hash{}) {
			return m.InfoHash
		}
	}
	return metainfo.Hash{}
}

func addOrGetTorrent(cl *torrent.Client, src string) (*torrent.Torrent, error) {
	if ih := mustParseMagnet(src); ih != (metainfo.Hash{}) {
		if t, ok := cl.Torrent(ih); ok {
			return t, nil
		}
	}
	if strings.HasPrefix(src, "magnet:") {
		t, err := cl.AddMagnet(src)
		if err != nil {
			return nil, err
		}
		if tiers := buildTrackerTiers(); len(tiers) != 0 {
			t.AddTrackers(tiers)
		}
		return t, nil
	}
	return cl.AddTorrentFromFile(src)
}

func waitForInfo(ctx context.Context, t *torrent.Torrent) error {
	select {
	case <-t.GotInfo():
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func chooseBestVideoFile(t *torrent.Torrent) (*torrent.File, int) {
	extOK := map[string]bool{".mp4": true, ".webm": true, ".m4v": true, ".mov": true, ".mkv": true}
	var best *torrent.File
	var idx int
	for i, f := range t.Files() {
		ext := strings.ToLower(filepath.Ext(f.Path()))
		if !extOK[ext] {
			continue
		}
		if best == nil || f.Length() > best.Length() {
			best, idx = f, i
		}
	}
	return best, idx
}

func contentTypeForName(name string) string {
	ct := mime.TypeByExtension(strings.ToLower(filepath.Ext(name)))
	// Don't map Matroska to webm. Let it be what it is.
	if ct != "" {
		return ct // "video/x-matroska" for .mkv on most systems
	}
	return "application/octet-stream"
}

func clamp(v, lo, hi int64) int64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// helper to safely compute total size when we have info
func torrentTotalSize(t *torrent.Torrent) int64 {
	if t.Info() == nil {
		return 0
	}
	var s int64
	for _, f := range t.Files() {
		s += f.Length()
	}
	return s
}

// NOTE: accept the interface, not *interface.
// Also, use Read (not ReadFull) to avoid long blocking when swarm is cold.
func prebuffer(r torrent.Reader, want int64, timeout time.Duration) int64 {
	if want <= 0 {
		return 0
	}
	buf := make([]byte, 256<<10)
	var done int64
	deadline := time.Now().Add(timeout)

	// Only responsiveness hint. DO NOT change readahead here to avoid
	// contention with stream/warmers touching priorities simultaneously.
	r.SetResponsive()

	for done < want && time.Now().Before(deadline) {
		toRead := len(buf)
		if rem := int(want - done); rem < toRead {
			toRead = rem
		}
		n, err := r.Read(buf[:toRead])
		if n > 0 {
			done += int64(n)
			continue
		}
		if err != nil {
			// transient or EOF — back off a bit and retry until timeout
			time.Sleep(200 * time.Millisecond)
		}
	}
	return done
}

// ==== watch-manager glue ====

// Build a playable "src" from a watch.Key-like ID.
// If it's an infohash (40-hex or 32-base32), synthesize a magnet.
// If it's already a magnet, sanitize and return it.
func srcFromID(id string) (string, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return "", errors.New("empty id")
	}
	// magnet as-is
	if strings.HasPrefix(id, "magnet:") {
		return sanitizeMagnet(id), nil
	}
	// 40-hex infohash
	if len(id) == 40 && strings.IndexFunc(id, func(r rune) bool {
		return !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F'))
	}) == -1 {
		return sanitizeMagnet("magnet:?xt=urn:btih:" + strings.ToUpper(id)), nil
	}
	// 32-chars (base32 infohash) — pass through, anacrolix accepts btih=BASE32 too
	if len(id) == 32 {
		return sanitizeMagnet("magnet:?xt=urn:btih:" + strings.ToUpper(id)), nil
	}
	return "", fmt.Errorf("unrecognized id: %q", id)
}

// Ensure the torrent exists/started for {cat,id}.
func ensureTorrentForKey(cat, id string) error {
	cat = validCat(cat)
	cl := getClientFor(cat)
	src, err := srcFromID(id)
	if err != nil {
		return err
	}
	t, err := addOrGetTorrent(cl, src)
	if err != nil {
		return err
	}
	// Kick metadata briefly so first stream is snappier
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = waitForInfo(ctx, t)
	lastTouch[key(cat, t.InfoHash())] = time.Now()
	return nil
}

// Best-effort stop by infohash/magnet on the given category.
func stopTorrentForKey(cat, id string) {
	cat = validCat(cat)
	clientsMu.Lock()
	cl := clients[cat]
	clientsMu.Unlock()
	if cl == nil {
		return
	}

	// Try to derive an infohash to match quickly
	var wantIH *metainfo.Hash
	if strings.HasPrefix(id, "magnet:") {
		if m, err := metainfo.ParseMagnetURI(id); err == nil && m.InfoHash != (metainfo.Hash{}) {
			h := m.InfoHash
			wantIH = &h
		}
	} else if len(id) == 40 {
		h := metainfo.NewHashFromHex(strings.ToUpper(id))
		wantIH = &h
	}

	for _, t := range cl.Torrents() {
		match := false
		if wantIH != nil {
			match = (t.InfoHash() == *wantIH)
		} else {
			// Fallback: match by hex
			if strings.EqualFold(t.InfoHash().HexString(), id) {
				match = true
			}
		}
		if match {
			log.Printf("[watch] dropping [%s] %s", cat, t.Name())
			t.Drop()
			delete(lastTouch, key(cat, t.InfoHash()))
			delete(lastFileIndex, key(cat, t.InfoHash()))
			return
		}
	}
}

// On Windows, add the long-path prefix to avoid MAX_PATH issues.
// Also normalize to an absolute, shallow path.
func winLongPath(p string) string {
	if os.PathSeparator != '\\' {
		return p
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		abs = p
	}
	// If already has \\?\ prefix, return as-is.
	if strings.HasPrefix(abs, `\\?\`) {
		return abs
	}
	// Don't prefix UNC \\server\share paths with \\?\ directly — those need \\?\UNC\...
	if strings.HasPrefix(abs, `\\`) {
		// Convert \\server\share\... -> \\?\UNC\server\share\...
		return `\\?\UNC\` + strings.TrimPrefix(abs, `\\`)
	}
	return `\\?\` + abs
}

func safeDownloadName(name string) string {
	// Strip Windows-forbidden characters
	repl := strings.NewReplacer("<", "", ">", "", ":", "", `"`, "", "/", "", `\`, "", "|", "", "?", "", "*", "")
	n := repl.Replace(name)
	n = strings.Trim(n, " .") // no trailing dot/space
	if len(n) == 0 {
		n = "video"
	}
	// Keep it short to be safe
	if len(n) > 120 {
		n = n[:120]
	}
	return n
}

func isLikely4K(name string, size int64) bool {
	n := strings.ToLower(name)
	if strings.Contains(n, "2160p") || strings.Contains(n, "4k") || strings.Contains(n, "uhd") {
		return true
	}
	// Remuxes / larger-than-8GiB are treated as heavy
	return size >= 8<<30
}

// Allow callers to override the target seconds while preserving state
func (c *bufCtl) SetTargetSeconds(playSec, pauseSec int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.state == statePlaying {
		c.targetAheadSec = playSec
	} else {
		c.targetAheadSec = pauseSec
	}
}

func buildBufferInfoOut(t *torrent.Torrent, f *torrent.File, fidx int, ctl *bufCtl) map[string]any {
	ctl.mu.Lock()
	state := ctl.state
	ph := ctl.playhead
	bps := ctl.rollingBps
	targetSec := ctl.targetAheadSec
	ctl.mu.Unlock()

	return map[string]any{
		"state":           string(state),
		"playheadBytes":   ph,
		"targetBytes":     ctl.TargetBytes(),
		"targetAheadSec":  targetSec,
		"rollingBps":      bps,
		"contiguousAhead": contiguousAheadPieceExact(t, f, ph),
		"fileIndex":       fidx,
		"fileLength":      f.Length(),
	}
}

func wantsSSE(r *http.Request) bool {
	if strings.EqualFold(r.URL.Query().Get("sse"), "1") {
		return true
	}
	// optional: also honor Accept: text/event-stream
	if strings.Contains(strings.ToLower(r.Header.Get("Accept")), "text/event-stream") {
		return true
	}
	return false
}

/* =========================
   HTTP handlers
   ========================= */

func handleAdd(w http.ResponseWriter, r *http.Request) {
	enableCORS(w)
	cat := parseCat(r.URL.Query())
	cl := getClientFor(cat)

	src, err := parseSrc(r.URL.Query())
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	t, err := addOrGetTorrent(cl, src)
	if strings.HasPrefix(src, "magnet:") {
		u, h, s, o := countTrackers(src)
		log.Printf("[trackers] udp=%d http=%d https=%d other=%d", u, h, s, o)
	}
	if err != nil {
		http.Error(w, "add torrent: "+err.Error(), 400)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), waitMetadata)
	defer cancel()
	metaStart := time.Now()
	_ = waitForInfo(ctx, t)
	metaMs := time.Since(metaStart).Milliseconds()

	ih := t.InfoHash()
	lastTouch[key(cat, ih)] = time.Now()

	var files []fileEntry
	if t.Info() != nil {
		for i, f := range t.Files() {
			files = append(files, fileEntry{Index: i, Name: f.Path(), Length: f.Length()})
		}
	}
	log.Printf("[add] cat=%s ih=%s name=%q metadataMs=%d files=%d", cat, ih.HexString(), t.Name(), metaMs, len(files))
	_ = json.NewEncoder(w).Encode(addResp{
		InfoHash: ih.HexString(),
		Name:     t.Name(),
		Files:    files,
	})
}

func handleFiles(w http.ResponseWriter, r *http.Request) {
	enableCORS(w)
	cat := parseCat(r.URL.Query())
	cl := getClientFor(cat)

	src, err := parseSrc(r.URL.Query())
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	t, err := addOrGetTorrent(cl, src)
	if err != nil {
		http.Error(w, "add torrent: "+err.Error(), 400)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), waitMetadata)
	defer cancel()
	if err := waitForInfo(ctx, t); err != nil {
		http.Error(w, "metadata timeout", http.StatusGatewayTimeout)
		return
	}
	lastTouch[key(cat, t.InfoHash())] = time.Now()

	var files []fileEntry
	for i, f := range t.Files() {
		files = append(files, fileEntry{Index: i, Name: f.Path(), Length: f.Length()})
	}
	log.Printf("[files] cat=%s ih=%s name=%q files=%d", cat, t.InfoHash().HexString(), t.Name(), len(files))
	_ = json.NewEncoder(w).Encode(files)
}

// /prefetch?magnet=...&cat=movie  → warms metadata and lightly prebuffers
func handlePrefetch(w http.ResponseWriter, r *http.Request) {
	enableCORS(w)
	cat := parseCat(r.URL.Query())
	cl := getClientFor(cat)

	src, err := parseSrc(r.URL.Query())
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	t, err := addOrGetTorrent(cl, src)
	if err != nil {
		http.Error(w, "add torrent: "+err.Error(), 400)
		return
	}

	// Wait for metadata
	ctx, cancel := context.WithTimeout(r.Context(), waitMetadata)
	defer cancel()
	metaStart := time.Now()
	if err := waitForInfo(ctx, t); err != nil {
		log.Printf("[prefetch] cat=%s name=%q metadata TIMEOUT after %s", cat, t.Name(), time.Since(metaStart))
		_ = json.NewEncoder(w).Encode(prefetchResp{
			InfoHash:   t.InfoHash().HexString(),
			Name:       t.Name(),
			MetadataMs: time.Since(metaStart).Milliseconds(),
			Note:       "metadata-timeout",
		})
		return
	}
	metaMs := time.Since(metaStart).Milliseconds()
	lastTouch[key(cat, t.InfoHash())] = time.Now()

	// choose file & do a tiny prebuffer to wake the swarm
	f, fidx := chooseBestVideoFile(t)
	if f == nil {
		_ = json.NewEncoder(w).Encode(prefetchResp{
			InfoHash:   t.InfoHash().HexString(),
			Name:       t.Name(),
			MetadataMs: metaMs,
			Note:       "no-playable-file",
		})
		return
	}

	// 🔒 ensure only one prefetch per (cat,ih,fileIndex)
	unlock := lockFor(fmt.Sprintf("prefetch:%s:%s:%d", cat, t.InfoHash().HexString(), fidx))
	defer unlock()

	rd := f.NewReader()
	defer rd.Close()
	_, _ = rd.Seek(0, io.SeekStart)
	readStart := time.Now()
	got := prebuffer(rd, min64(prebufferN, 512<<10), prebufferTO) // up to 512 KiB on prefetch
	log.Printf("[prefetch] cat=%s ih=%s file=%d bytes=%d in %s",
		cat, t.InfoHash().HexString(), fidx, got, time.Since(readStart))

	// file list (handy for the UI dialog)
	var files []fileEntry
	for i, ff := range t.Files() {
		files = append(files, fileEntry{Index: i, Name: ff.Path(), Length: ff.Length()})
	}

	_ = json.NewEncoder(w).Encode(prefetchResp{
		InfoHash:       t.InfoHash().HexString(),
		Name:           t.Name(),
		FileIndex:      fidx,
		FileName:       f.Path(),
		FileLength:     f.Length(),
		MetadataMs:     metaMs,
		PrebufferBytes: got,
		PrebufferMs:    time.Since(readStart).Milliseconds(),
		Note:           "ok",
		Files:          files,
	})
}

func handleStream(w http.ResponseWriter, r *http.Request) {
	// Guard the handler so panics never take the process down.
	defer func() {
		if rec := recover(); rec != nil {
			log.Printf("[stream] panic recovered: %v\n%s", rec, debug.Stack())
			// don't re-panic; just end this request
		}
	}()

	enableCORS(w)
	cat := parseCat(r.URL.Query())
	cl := getClientFor(cat)

	src, err := parseSrc(r.URL.Query())
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	t, err := addOrGetTorrent(cl, src)
	if strings.HasPrefix(src, "magnet:") {
		u, h, s, o := countTrackers(src)
		log.Printf("[trackers] udp=%d http=%d https=%d other=%d", u, h, s, o)
	}
	if err != nil {
		http.Error(w, "add torrent: "+err.Error(), http.StatusBadRequest)
		return
	}

	// Wait for metadata
	ctx, cancel := context.WithTimeout(r.Context(), waitMetadata)
	defer cancel()
	metaStart := time.Now()
	if err := waitForInfo(ctx, t); err != nil {
		log.Printf("[stream] cat=%s name=%q metadata TIMEOUT after %s", cat, t.Name(), time.Since(metaStart))
		http.Error(w, "metadata timeout", http.StatusGatewayTimeout)
		return
	}
	lastTouch[key(cat, t.InfoHash())] = time.Now()

	// Pick file
	var f *torrent.File
	fidx := 0
	if idxStr := r.URL.Query().Get("fileIndex"); idxStr != "" {
		if n, _ := strconv.Atoi(idxStr); n >= 0 && n < len(t.Files()) {
			f = t.Files()[n]
			fidx = n
		}
	}
	if f == nil {
		f, fidx = chooseBestVideoFile(t)
	}
	if f == nil {
		http.Error(w, "no playable file in torrent", http.StatusNotFound)
		return
	}

	lastFileIndex[key(cat, t.InfoHash())] = fidx

	k := keyFile(cat, t.InfoHash(), fidx)
	ctl := getCtl(k)

	if isLikely4K(f.Path(), f.Length()) {
		playSec := targetPlay4KSec
		pauseSec := targetPause4KSec
		if playSec <= 0 {
			playSec = 180
		}
		if pauseSec <= 0 {
			pauseSec = 600
		}
		ctl.SetTargetSeconds(playSec, pauseSec)
	}

	size := f.Length()
	name := f.Path()

	// Range parsing
	var start, end int64
	start, end = 0, size-1
	if rh := r.Header.Get("Range"); rh != "" && strings.HasPrefix(strings.ToLower(rh), "bytes=") {
		parts := strings.SplitN(strings.TrimPrefix(strings.ToLower(rh), "bytes="), "-", 2)
		if len(parts) == 2 {
			if parts[0] != "" {
				if s, err := strconv.ParseInt(parts[0], 10, 64); err == nil {
					start = s
				}
			}
			if parts[1] != "" {
				if e, err := strconv.ParseInt(parts[1], 10, 64); err == nil {
					end = e
				}
			}
		}
	}
	start = clamp(start, 0, size-1)
	end = clamp(end, start, size-1)
	length := end - start + 1

	// Controller-driven reader + dynamic warm-up
	ctl.SetState(statePlaying)
	ctl.SetPlayhead(start)

	target := ctl.TargetBytes()

	reader := f.NewReader()
	defer reader.Close()
	if _, err := reader.Seek(start, io.SeekStart); err != nil {
		http.Error(w, "seek error: "+err.Error(), http.StatusInternalServerError)
		return
	}
	reader.SetResponsive()
	reader.SetReadahead(target)

	// dynamic warm-up: read up to min(target, warmReadAheadMB)
	localWarmMB := warmReadAheadMB
	if isLikely4K(f.Path(), f.Length()) {
		// Prefer explicit env override, else ensure at least 64 MiB
		if warmReadAhead4KMB > 0 {
			localWarmMB = warmReadAhead4KMB
		} else if localWarmMB < 64 {
			localWarmMB = 64
		}
	}
	warmWant := min64(target, localWarmMB<<20)
	if warmWant > 256<<10 && length >= 512<<10 {
		warmStart := time.Now()
		got := prebuffer(reader, min64(warmWant, length), prebufferTO)
		ctl.UpdateThroughput(got, int64(time.Since(warmStart).Milliseconds()))
		_, _ = reader.Seek(start, io.SeekStart) // rewind
	}

	// Optional: surface buffer hints to the UI
	w.Header().Set("X-Buffer-Target-Bytes", strconv.FormatInt(target, 10))
	w.Header().Set("X-Buffered-Ahead-Probe", strconv.FormatInt(contiguousAheadPieceExact(t, f, start), 10))

	// 🔧 Rewind so we don't consume the client's requested range.
	if warmWant > 0 {
		if _, err := reader.Seek(start, io.SeekStart); err != nil {
			log.Printf("[stream] rewind after prebuffer failed: %v", err)
		}
	}

	// Headers
	ct := contentTypeForName(name)
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Content-Disposition", fmt.Sprintf("inline; filename=%q", safeDownloadName(filepath.Base(name))))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-File-Index", strconv.Itoa(fidx))
	w.Header().Set("X-File-Name", filepath.Base(name))
	if start == 0 && end == size-1 {
		w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	} else {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, size))
		w.Header().Set("Content-Length", strconv.FormatInt(length, 10))
		w.WriteHeader(http.StatusPartialContent)
	}

	// Stream loop (context-aware, robust to disconnects)
	rc := http.NewResponseController(w) // Go 1.20+
	buf := make([]byte, 256<<10)        // 256 KiB
	var written int64

	for written < length {
		// Client cancel/seek/etc.
		select {
		case <-r.Context().Done():
			return
		default:
		}

		toRead := int64(len(buf))
		if rem := length - written; rem < toRead {
			toRead = rem
		}
		reader.SetResponsive()
		readStart := time.Now()
		n, readErr := reader.Read(buf[:toRead])

		if n > 0 {
			ctl.UpdateThroughput(int64(n), int64(time.Since(readStart).Milliseconds()))
			// keep torrent alive while actively streaming
			lastTouch[key(cat, t.InfoHash())] = time.Now()

			if _, err := w.Write(buf[:n]); err != nil {
				if clientGone(err) {
					// benign: client went away
					return
				}
				log.Printf("[stream] client write error: %v", err)
				return
			}
			if err := rc.Flush(); err != nil {
				if clientGone(err) {
					return
				}
				log.Printf("[stream] flush error: %v", err)
				return
			}
			written += int64(n)
		}

		if readErr != nil {
			if errors.Is(readErr, io.EOF) || errors.Is(readErr, io.ErrUnexpectedEOF) {
				break
			}
			if clientGone(readErr) {
				return
			}
			// transient: backoff a bit
			time.Sleep(200 * time.Millisecond)
		}
	}

	log.Printf("[stream] cat=%s name=%q fileIdx=%d range=%d-%d len=%d target=%d",
		cat, t.Name(), fidx, start, end, written, target)
}

func handleStats(w http.ResponseWriter, r *http.Request) {
	enableCORS(w)

	// Optional filters: ?cat=movie or ?infoHash=ABC...
	wantCat := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("cat")))
	wantIH := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("infoHash")))

	resp := statsResp{
		UptimeSeconds:   int64(time.Since(startTime).Seconds()),
		DataRoot:        dataRoot,
		TotalCacheBytes: dirSize(dataRoot),
		CacheMaxBytes:   cacheMax,
		EvictTTL:        evictTTL.String(),
		TrackersMode:    strings.ToLower(getenvDefault("TRACKERS_MODE", "udp")),
	}

	// Collect categories that currently have clients
	clientsMu.Lock()
	cats := make([]string, 0, len(clients))
	for c := range clients {
		cats = append(cats, c)
	}
	clientsMu.Unlock()
	sort.Strings(cats)

	for _, cat := range cats {
		if wantCat != "" && wantCat != cat {
			continue
		}
		cl := getClientFor(cat)

		var tstats []torrentStat
		for _, t := range cl.Torrents() {
			ih := strings.ToLower(t.InfoHash().HexString())

			if wantIH != "" && !strings.EqualFold(wantIH, ih) {
				continue
			}

			haveInfo := t.Info() != nil
			size := torrentTotalSize(t)

			best, bestIdx := (*torrent.File)(nil), -1
			if haveInfo {
				if bf, idx := chooseBestVideoFile(t); bf != nil {
					best = bf
					bestIdx = idx
				}
			}

			// last file index selected (from streaming)
			k := key(cat, t.InfoHash())
			var selPtr *int
			if idx, ok := lastFileIndex[k]; ok {
				sel := idx
				selPtr = &sel
			}

			// last touch (from lastTouch map)
			last := "never"
			if ts, ok := lastTouch[k]; ok {
				last = ts.Format(time.RFC3339)
			}

			ts := torrentStat{
				InfoHash:  ih,
				Name:      t.Name(),
				HaveInfo:  haveInfo,
				Size:      size,
				NumFiles:  len(t.Files()),
				BestIndex: bestIdx,
				BestName: func() string {
					if best != nil {
						return best.Path()
					}
					return ""
				}(),
				BestLength: func() int64 {
					if best != nil {
						return best.Length()
					}
					return 0
				}(),
				SelectedIndex: selPtr,
				LastTouched:   last,
			}
			if best != nil && bestIdx >= 0 {
				bk := keyFile(cat, t.InfoHash(), bestIdx)
				ctl := getCtl(bk)

				// Read controller state safely
				ctl.mu.Lock()
				ph := ctl.playhead
				tgt := ctl.TargetBytes()
				ctl.mu.Unlock()

				ts.BufferedAhead = contiguousAheadPieceExact(t, best, ph)
				ts.TargetAhead = tgt
			}
			tstats = append(tstats, ts)
		}

		// sort torrents by lastTouched desc, then name
		sort.Slice(tstats, func(i, j int) bool {
			li := tstats[i].LastTouched
			lj := tstats[j].LastTouched
			if li != "never" && lj != "never" {
				return li > lj
			}
			if li != "never" {
				return true
			}
			if lj != "never" {
				return false
			}
			return tstats[i].Name < tstats[j].Name
		})

		resp.Categories = append(resp.Categories, categoryStats{
			Category: cat,
			Torrents: tstats,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

func handleBufferState(w http.ResponseWriter, r *http.Request) {
	enableCORS(w)
	q := r.URL.Query()
	cat := parseCat(q)

	cl := getClientFor(cat)
	src, err := parseSrc(q)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	t, err := addOrGetTorrent(cl, src)
	if err != nil {
		http.Error(w, "add torrent: "+err.Error(), 400)
		return
	}

	if err := waitForInfo(r.Context(), t); err != nil {
		http.Error(w, "metadata timeout", http.StatusGatewayTimeout)
		return
	}

	// choose the file index same as /stream
	var f *torrent.File
	fidx := 0
	if idxStr := q.Get("fileIndex"); idxStr != "" {
		if n, _ := strconv.Atoi(idxStr); n >= 0 && n < len(t.Files()) {
			f = t.Files()[n]
			fidx = n
		}
	}
	if f == nil {
		if bf, bi := chooseBestVideoFile(t); bf != nil {
			f, fidx = bf, bi
		}
	}
	if f == nil {
		http.Error(w, "no playable file", 404)
		return
	}

	k := keyFile(cat, t.InfoHash(), fidx)
	ctl := getCtl(k)

	if isLikely4K(f.Path(), f.Length()) {
		playSec := targetPlay4KSec
		pauseSec := targetPause4KSec
		if playSec <= 0 {
			playSec = 180
		}
		if pauseSec <= 0 {
			pauseSec = 600
		}
		ctl.SetTargetSeconds(playSec, pauseSec)
	}

	switch strings.ToLower(q.Get("state")) {
	case "pause":
		ctl.SetState(statePaused)
		// start warmer from last known playhead (default 0)
		ctl.mu.Lock()
		ph := ctl.playhead
		ctl.mu.Unlock()
		ctl.startWarm(cat, t, f, ph)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "state": "paused"})
	case "play":
		ctl.SetState(statePlaying)
		ctl.stopWarm()
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "state": "playing"})
	default:
		http.Error(w, "state must be pause|play", 400)
	}
}

func handleBufferInfo(w http.ResponseWriter, r *http.Request) {
	enableCORS(w)
	q := r.URL.Query()
	cat := parseCat(q)

	cl := getClientFor(cat)
	src, err := parseSrc(q)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	t, err := addOrGetTorrent(cl, src)
	if err != nil {
		http.Error(w, "add torrent: "+err.Error(), 400)
		return
	}
	if err := waitForInfo(r.Context(), t); err != nil {
		http.Error(w, "metadata timeout", http.StatusGatewayTimeout)
		return
	}

	// choose same file logic as /stream
	var f *torrent.File
	fidx := 0
	if idxStr := q.Get("fileIndex"); idxStr != "" {
		if n, _ := strconv.Atoi(idxStr); n >= 0 && n < len(t.Files()) {
			f = t.Files()[n]
			fidx = n
		}
	}
	if f == nil {
		if bf, bi := chooseBestVideoFile(t); bf != nil {
			f, fidx = bf, bi
		}
	}
	if f == nil {
		http.Error(w, "no playable file", 404)
		return
	}

	k := keyFile(cat, t.InfoHash(), fidx)
	ctl := getCtl(k)

	// 4K overrides (same as /stream)
	if isLikely4K(f.Path(), f.Length()) {
		playSec := targetPlay4KSec
		pauseSec := targetPause4KSec
		if playSec <= 0 {
			playSec = 180
		}
		if pauseSec <= 0 {
			pauseSec = 600
		}
		ctl.SetTargetSeconds(playSec, pauseSec)
	}

	// ---- SSE mode? ----
	if wantsSSE(r) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache, no-transform")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")

		// optional: initial reconnection hint for EventSource
		_, _ = io.WriteString(w, "retry: 2000\n\n")
		rc := http.NewResponseController(w)

		write := func() bool {
			out := buildBufferInfoOut(t, f, fidx, ctl)
			b, _ := json.Marshal(out)
			if _, err := fmt.Fprintf(w, "data: %s\n\n", b); err != nil {
				return false
			}
			_ = rc.Flush()
			// keep torrent considered "active"
			lastTouch[key(cat, t.InfoHash())] = time.Now()
			return true
		}

		if !write() {
			return
		}

		tick := time.NewTicker(1 * time.Second) // you can tune this
		defer tick.Stop()
		ping := time.NewTicker(15 * time.Second) // comment pings for proxies
		defer ping.Stop()

		for {
			select {
			case <-r.Context().Done():
				return
			case <-tick.C:
				if !write() {
					return
				}
			case <-ping.C:
				_, _ = io.WriteString(w, ": keepalive\n\n")
				_ = rc.Flush()
			}
		}
	}

	// ---- one-shot JSON (existing behavior) ----
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(buildBufferInfoOut(t, f, fidx, ctl))
}

/* =========================
   housekeeping
   ========================= */

func clientGone(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	if errors.Is(err, net.ErrClosed) {
		return true
	}
	// Text matches for cross-platform "client vanished" cases
	s := err.Error()
	if strings.Contains(s, "broken pipe") || strings.Contains(s, "reset by peer") {
		return true
	}
	// Windows-specific: ECONNRESET/ECONNABORTED on writes
	var op *net.OpError
	if errors.As(err, &op) {
		if se, ok := op.Err.(*os.SyscallError); ok {
			if se.Err == syscall.WSAECONNRESET || se.Err == syscall.WSAECONNABORTED {
				return true
			}
		}
	}
	return false
}

func lockFor(key string) func() {
	m, _ := prefetchLocks.LoadOrStore(key, &sync.Mutex{})
	mu := m.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}
func enableCORS(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set(
		"Access-Control-Expose-Headers",
		"Content-Length, Content-Range, Content-Type, X-File-Index, X-File-Name, X-Buffer-Target-Bytes, X-Buffered-Ahead-Probe",
	)
}

func dirSize(root string) int64 {
	var total int64
	_ = filepath.Walk(root, func(_ string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			total += info.Size()
		}
		return nil
	})
	return total
}

func janitor() {
	t := time.NewTicker(2 * time.Minute)
	defer t.Stop()
	for range t.C {
		now := time.Now()

		// age-based drop
		if evictTTL > 0 {
			clientsMu.Lock()
			for cat, c := range clients {
				for _, tt := range c.Torrents() {
					k := key(cat, tt.InfoHash())
					if last, ok := lastTouch[k]; ok && now.Sub(last) > evictTTL {
						log.Printf("[janitor] dropping idle [%s] %s", cat, tt.Name())
						tt.Drop()
						delete(lastTouch, k)
					}
				}
			}
			clientsMu.Unlock()
		}

		// size-based cap
		if cacheMax > 0 && dirSize(dataRoot) > cacheMax {
			var oldest string
			var oldestAt time.Time
			for k, at := range lastTouch {
				if oldestAt.IsZero() || at.Before(oldestAt) {
					oldest, oldestAt = k, at
				}
			}
			if oldest != "" {
				parts := strings.SplitN(oldest, ":", 2) // cat:ih
				if len(parts) == 2 {
					cat := parts[0]
					ih := metainfo.NewHashFromHex(parts[1])
					clientsMu.Lock()
					if c := clients[cat]; c != nil {
						for _, tt := range c.Torrents() {
							if tt.InfoHash() == ih {
								log.Printf("[janitor] evicting [%s] %s to honor CACHE_MAX_BYTES", cat, tt.Name())
								tt.Drop()
								break
							}
						}
					}
					clientsMu.Unlock()
					delete(lastTouch, oldest)
				}
			}
		}
	}
}

// contiguousAheadPieceExact returns the count of *file bytes* we can
// read contiguously from "from" before hitting the first *incomplete piece*.
// It is read-free and uses piece completion state.
//
// Notes:
//   - Piece granularity: if the starting piece isn't complete we return 0,
//     even if some bytes might actually be available; this is conservative
//     and avoids misleading the UI.
//   - At file boundaries where a piece spans multiple files, an incomplete
//     piece belonging to *another* file will still count as incomplete here;
//     that's a safe under-report.
func contiguousAheadPieceExact(t *torrent.Torrent, f *torrent.File, from int64) int64 {
	info := t.Info()
	if info == nil {
		return 0
	}
	fileLen := f.Length()
	if from >= fileLen {
		return 0
	}
	pieceLen := info.PieceLength // BEP3 piece length
	if pieceLen <= 0 {
		return 0
	}

	fileStartGlobal := f.Offset() + from
	fileEndGlobal := f.Offset() + fileLen

	startPiece := int(fileStartGlobal / pieceLen)
	pieceOff := fileStartGlobal % pieceLen

	// If the starting piece isn't fully complete, be conservative.
	if t.PieceBytesMissing(startPiece) != 0 {
		return 0
	}

	var ahead int64
	// Account remainder of starting piece segment within this file
	segEnd := min64(fileEndGlobal, (int64(startPiece)+1)*pieceLen)
	ahead += segEnd - (int64(startPiece)*pieceLen + pieceOff)

	// Walk subsequent pieces until the end of the file or first incomplete piece
	for p := startPiece + 1; (int64(p) * pieceLen) < fileEndGlobal; p++ {
		if t.PieceBytesMissing(p) != 0 {
			break
		}
		ps := int64(p) * pieceLen
		pe := ps + pieceLen
		if pe > fileEndGlobal {
			pe = fileEndGlobal
		}
		ahead += pe - ps
	}
	return ahead
}

/* =========================
   main
   ========================= */

func main() {
	_ = godotenv.Load(".env")

	// logging first
	logFilePath = getenvDefault("LOG_FILE", "debug.log")
	setupLogging()

	// paths & cache controls
	dataRoot = getenvDefault("TORRENT_DATA_ROOT", "./vod-cache")
	_ = os.MkdirAll(dataRoot, 0o755)
	cacheMax = getenvInt64("CACHE_MAX_BYTES", 0)
	evictTTL = getenvDuration("CACHE_EVICT_TTL", 0)

	// tunables
	waitMetadata = getenvDuration("WAIT_METADATA_MS", waitMetadata)
	prebufferN = getenvInt64("PREBUFFER_BYTES", prebufferN)
	prebufferTO = getenvDuration("PREBUFFER_TIMEOUT_MS", prebufferTO)
	trackersMode = strings.ToLower(getenvDefault("TRACKERS_MODE", trackersMode)) // all|http|udp|none

	targetPlaySec = getenvInt64("TARGET_BUFFER_PLAY_SEC", targetPlaySec)
	targetPauseSec = getenvInt64("TARGET_BUFFER_PAUSE_SEC", targetPauseSec)
	warmReadAheadMB = getenvInt64("WARM_READ_AHEAD_MB", warmReadAheadMB)

	targetPlay4KSec = getenvInt64("TARGET_BUFFER_PLAY_SEC_4K", 180)
	targetPause4KSec = getenvInt64("TARGET_BUFFER_PAUSE_SEC_4K", 600)
	warmReadAhead4KMB = getenvInt64("WARM_READ_AHEAD_MB_4K", 64)

	if s := strings.ToLower(getenvDefault("ENDGAME_DUPLICATE", "true")); s == "false" {
		enableEndgameDup = false
	}

	go janitor()

	mux := http.NewServeMux()
	mux.HandleFunc("/add", handleAdd)     // ?magnet=...&cat=movie
	mux.HandleFunc("/files", handleFiles) // ?magnet=...&cat=tv
	mux.HandleFunc("/prefetch", handlePrefetch)
	mux.HandleFunc("/stream", handleStream) // ?magnet=...&cat=anime&fileIndex=0
	mux.HandleFunc("/stats", handleStats)   // ?cat=movie&infoHash=ABC...

	// --- Watch/lease manager wiring ---
	mgr := watch.NewManager(
		20*time.Second, // staleAfter: if no ping > 20s, eligible to stop
		30*time.Second, // ticker: reaper runs every 30s
		// Ensure:
		func(k watch.Key) error { return ensureTorrentForKey(k.Cat, k.ID) },
		// Stop:
		func(k watch.Key) { stopTorrentForKey(k.Cat, k.ID) },
	)

	// CORS-wrapped endpoints (so your Next.js app can call them)
	mux.HandleFunc("/watch/open", func(w http.ResponseWriter, r *http.Request) {
		enableCORS(w)
		if r.Method == http.MethodOptions {
			return
		}
		mgr.HandleOpen(w, r)
	})
	mux.HandleFunc("/watch/ping", func(w http.ResponseWriter, r *http.Request) {
		enableCORS(w)
		if r.Method == http.MethodOptions {
			return
		}
		mgr.HandlePing(w, r)
	})
	mux.HandleFunc("/watch/close", func(w http.ResponseWriter, r *http.Request) {
		enableCORS(w)
		if r.Method == http.MethodOptions {
			return
		}
		mgr.HandleClose(w, r)
	})

	mux.HandleFunc("/buffer/state", handleBufferState)
	mux.HandleFunc("/buffer/info", handleBufferInfo)

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			enableCORS(w)
			return
		}
		http.NotFound(w, r)
	})

	addr := getenvDefault("LISTEN", ":4001")
	log.Printf("[boot] VOD listening on %s root=%s prebuffer=%dB/%s waitMetadata=%s trackersMode=%s",
		addr, dataRoot, prebufferN, prebufferTO, waitMetadata, trackersMode)

	if err := http.ListenAndServe(addr, mux); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

/* =========================
   utils
   ========================= */

func min64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}

// =========================
// Buffer Controller
// =========================

type playState string

const (
	statePlaying playState = "playing"
	statePaused  playState = "paused"
)

type bufKey struct {
	Cat  string
	IH   string
	FIdx int
}

type bufCtl struct {
	mu sync.Mutex

	state          playState
	playhead       int64 // bytes
	rollingBps     int64 // bytes/sec (EWMA)
	targetAheadSec int64 // cache of last computed target (sec)
	// warmer control
	warmCtx    context.Context
	warmCancel context.CancelFunc
}

var (
	bufMu    sync.Mutex
	bufCtrls = map[bufKey]*bufCtl{}
)

func keyFile(cat string, ih metainfo.Hash, fidx int) bufKey {
	return bufKey{Cat: validCat(cat), IH: ih.HexString(), FIdx: fidx}
}

func getCtl(k bufKey) *bufCtl {
	bufMu.Lock()
	defer bufMu.Unlock()
	if c, ok := bufCtrls[k]; ok {
		return c
	}
	c := &bufCtl{
		state:          statePlaying,
		rollingBps:     defaultBitrateBps,
		targetAheadSec: targetPlaySec,
	}
	bufCtrls[k] = c
	return c
}

func (c *bufCtl) SetState(ps playState) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.state = ps
	c.targetAheadSec = map[playState]int64{
		statePlaying: targetPlaySec,
		statePaused:  targetPauseSec,
	}[ps]
}

func (c *bufCtl) SetPlayhead(pos int64) {
	c.mu.Lock()
	c.playhead = pos
	c.mu.Unlock()
}

func (c *bufCtl) UpdateThroughput(bytes, millis int64) {
	if millis <= 0 || bytes <= 0 {
		return
	}
	// EWMA toward observed bps
	obs := (bytes * 1000) / millis
	if obs <= 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.rollingBps == 0 {
		c.rollingBps = obs
		return
	}
	// 0.7 old, 0.3 new
	c.rollingBps = (c.rollingBps*7 + obs*3) / 10
}

func (c *bufCtl) TargetBytes() int64 {
	c.mu.Lock()
	bps := c.rollingBps
	sec := c.targetAheadSec
	c.mu.Unlock()
	if bps <= 0 {
		bps = defaultBitrateBps
	}
	// if slow swarm, grow target a bit so we stay safe
	if bps < defaultBitrateBps {
		sec = sec + sec/3 // +33%
	}
	return bps * sec
}

// =========================
// Pause Warmer
// =========================

func (c *bufCtl) startWarm(cat string, t *torrent.Torrent, f *torrent.File, start int64) {
	c.mu.Lock()
	if c.warmCancel != nil {
		c.mu.Unlock()
		return // already warming
	}
	ctx, cancel := context.WithCancel(context.Background())
	c.warmCtx = ctx
	c.warmCancel = cancel
	c.mu.Unlock()

	go func() {
		defer func() {
			c.mu.Lock()
			if c.warmCancel != nil {
				c.warmCancel = nil
				c.warmCtx = nil
			}
			c.mu.Unlock()
		}()

		rd := f.NewReader()
		defer rd.Close()

		pos := start
		for {
			c.mu.Lock()
			st := c.state
			ctx := c.warmCtx
			target := c.TargetBytes()
			c.mu.Unlock()

			if st != statePaused || ctx == nil {
				return
			}

			// Move to latest playhead (it may have changed)
			c.mu.Lock()
			pos = c.playhead
			c.mu.Unlock()
			if _, err := rd.Seek(pos, io.SeekStart); err != nil {
				time.Sleep(300 * time.Millisecond)
				continue
			}
			rd.SetResponsive()
			rd.SetReadahead(target)

			need := target - contiguousAheadPieceExact(t, f, pos)
			if need <= 256<<10 { // good enough
				time.Sleep(750 * time.Millisecond)
				continue
			}

			chunk := need
			localWarmMB := warmReadAheadMB
			if isLikely4K(f.Path(), f.Length()) {
				if warmReadAhead4KMB > 0 {
					localWarmMB = warmReadAhead4KMB
				} else if localWarmMB < 64 {
					localWarmMB = 64
				}
			}
			maxChunk := localWarmMB << 20
			if chunk > maxChunk {
				chunk = maxChunk
			}
			start := time.Now()
			got := prebuffer(rd, chunk, 5*time.Second)
			c.UpdateThroughput(got, int64(time.Since(start).Milliseconds()))

			select {
			case <-time.After(150 * time.Millisecond):
			case <-ctx.Done():
				return
			}
		}
	}()
}

func (c *bufCtl) stopWarm() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.warmCancel != nil {
		c.warmCancel()
		c.warmCancel = nil
		c.warmCtx = nil
	}
}
