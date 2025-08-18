package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/anacrolix/torrent"
	"github.com/anacrolix/torrent/metainfo"
	"github.com/joho/godotenv"
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
)

func setupLogging() {
	if p := os.Getenv("LOG_FILE"); p != "" {
		f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
		if err != nil {
			log.Printf("WARN opening LOG_FILE=%q: %v", p, err)
			return
		}
		log.SetOutput(io.MultiWriter(os.Stdout, f))
		log.Printf("logging to %s", p)
	}
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
	if c := mime.TypeByExtension(strings.ToLower(filepath.Ext(name))); c != "" {
		if strings.Contains(c, "video/x-matroska") {
			return "video/webm"
		}
		return c
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

	// Hints (if available)
	// These methods exist on the concrete that implements torrent.Reader in your version.
	r.SetReadahead(want)
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
		http.Error(w, "no playable file in torrent", 404)
		return
	}

	lastFileIndex[key(cat, t.InfoHash())] = fidx

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

	// Reader drives piece priorities (interface!)
	reader := f.NewReader()
	defer reader.Close()
	if _, err := reader.Seek(start, io.SeekStart); err != nil {
		http.Error(w, "seek error: "+err.Error(), 500)
		return
	}
	reader.SetResponsive()

	// Optional prebuffer
	var warmed int64
	if prebufferN > 0 {
		want := min64(prebufferN, length)
		warmStart := time.Now()
		warmed = prebuffer(reader, want, prebufferTO)
		log.Printf("[stream] prebuffer cat=%s ih=%s file=%d want=%d got=%d took=%s",
			cat, t.InfoHash().HexString(), fidx, want, warmed, time.Since(warmStart))
	}

	// Headers
	ct := contentTypeForName(name)
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Content-Disposition", fmt.Sprintf("inline; filename=%q", filepath.Base(name)))
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

	// Stream loop
	buf := make([]byte, 256<<10)
	var written int64
	for written < length {
		toRead := int64(len(buf))
		if rem := length - written; rem < toRead {
			toRead = rem
		}
		reader.SetResponsive()
		n, readErr := io.ReadFull(reader, buf[:toRead])
		if n > 0 {
			if _, err := w.Write(buf[:n]); err != nil {
				log.Printf("[stream] client write error: %v", err)
				return
			}
			if fsh, ok := w.(http.Flusher); ok {
				fsh.Flush()
			}
			written += int64(n)
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) || errors.Is(readErr, io.ErrUnexpectedEOF) {
				break
			}
			time.Sleep(200 * time.Millisecond)
		}
	}
	log.Printf("[stream] cat=%s name=%q fileIdx=%d range=%d-%d len=%d warmed=%d",
		cat, t.Name(), fidx, start, end, written, warmed)
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

/* =========================
   housekeeping
   ========================= */

func enableCORS(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Content-Type, X-File-Index, X-File-Name")
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

	go janitor()

	mux := http.NewServeMux()
	mux.HandleFunc("/add", handleAdd)     // ?magnet=...&cat=movie
	mux.HandleFunc("/files", handleFiles) // ?magnet=...&cat=tv
	mux.HandleFunc("/prefetch", handlePrefetch)
	mux.HandleFunc("/stream", handleStream) // ?magnet=...&cat=anime&fileIndex=0
	mux.HandleFunc("/stats", handleStats)   // ?cat=movie&infoHash=ABC...

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
