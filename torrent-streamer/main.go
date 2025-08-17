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
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/anacrolix/torrent"
	"github.com/anacrolix/torrent/metainfo"
	"github.com/joho/godotenv"
)

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

/* ===== env & globals ===== */

var (
	dataRoot  string
	cacheMax  int64
	evictTTL  time.Duration
	clientsMu sync.Mutex
	clients   = make(map[string]*torrent.Client) // cat -> client
	lastTouch = make(map[string]time.Time)       // key(cat:infohash) -> time
)

func getenvDefault(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func key(cat string, ih metainfo.Hash) string { return cat + ":" + ih.HexString() }

/* ===== client per-category ===== */

func validCat(c string) string {
	c = strings.ToLower(strings.TrimSpace(c))
	switch c {
	case "movie", "tv", "anime":
		return c
	case "":
		return "misc"
	default:
		return c // allow arbitrary extra buckets if you want
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

	// Harden networking: HTTP(S) trackers only + no UDP uTP/DHT/IPv6
	cfg.NoDHT = true
	cfg.DisableUTP = true
	cfg.DisableIPv6 = true

	cfg.Seed = false
	cfg.NoUpload = true
	cfg.Debug = false

	c, err := torrent.NewClient(cfg)
	if err != nil {
		log.Fatalf("client(%s) init: %v", cat, err)
	}
	clients[cat] = c
	log.Printf("client(%s) using dir: %s", cat, dir)
	return c
}

/* ===== helpers ===== */

type urlQ interface{ Get(string) string }

func parseCat(q urlQ) string { return validCat(q.Get("cat")) }

func parseSrc(q urlQ) (string, error) {
	if s := q.Get("magnet"); s != "" {
		return s, nil
	}
	if s := q.Get("src"); s != "" {
		return s, nil
	}
	if ih := strings.TrimSpace(q.Get("infoHash")); ih != "" {
		if len(ih) == 40 || len(ih) == 32 {
			return "magnet:?xt=urn:btih:" + strings.ToUpper(ih), nil
		}
	}
	return "", errors.New("missing magnet/src/infoHash")
}

func mustParseMagnet(src string) metainfo.Hash {
	if strings.HasPrefix(src, "magnet:") {
		m, err := metainfo.ParseMagnetURI(src)
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
		return cl.AddMagnet(src)
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
	for i, f := range t.Files() { // []*torrent.File
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

/* ===== HTTP handlers ===== */

func sanitizeMagnetHTTPOnly(src string) string {
	if !strings.HasPrefix(src, "magnet:") {
		return src
	}
	// Extract query part after '?'
	qs := src
	if i := strings.Index(src, "?"); i >= 0 {
		qs = src[i+1:]
	} else {
		return src
	}

	vals, err := url.ParseQuery(qs)
	if err != nil {
		return src // fallback to original on parse error
	}

	// Collect all tracker params: "tr" and "tr.N"
	var all []string
	for k, v := range vals {
		if k == "tr" || strings.HasPrefix(k, "tr.") {
			all = append(all, v...)
			delete(vals, k)
		}
	}

	// Filter to http/https only
	var filtered []string
	for _, tr := range all {
		tr = strings.TrimSpace(tr)
		if strings.HasPrefix(tr, "http://") || strings.HasPrefix(tr, "https://") {
			filtered = append(filtered, tr)
		}
	}
	if len(filtered) == 0 {
		filtered = []string{
			"https://tracker.opentrackr.org:443/announce",
			"http://tracker.opentrackr.org:1337/announce",
		}
	}
	for _, tr := range filtered {
		vals.Add("tr", tr)
	}

	return "magnet:?" + vals.Encode()
}

// Add (or reuse) torrent; on magnets, strip UDP trackers and keep HTTP(S)
func addOrGetTorrentHTTPOnly(cl *torrent.Client, src string) (*torrent.Torrent, error) {
	if ih := mustParseMagnet(src); ih != (metainfo.Hash{}) {
		if t, ok := cl.Torrent(ih); ok {
			return t, nil
		}
	}
	if strings.HasPrefix(src, "magnet:") {
		sanitized := sanitizeMagnetHTTPOnly(src)
		return cl.AddMagnet(sanitized)
	}
	return cl.AddTorrentFromFile(src)
}
func httpOnlyTrackers(trackers [][]string) [][]string {
	out := make([][]string, 0, len(trackers))
	for _, tier := range trackers {
		var t []string
		for _, u := range tier {
			if strings.HasPrefix(u, "http://") || strings.HasPrefix(u, "https://") {
				t = append(t, u)
			}
		}
		if len(t) > 0 {
			out = append(out, t)
		}
	}
	return out
}

func handleAdd(w http.ResponseWriter, r *http.Request) {
	enableCORS(w)
	cat := parseCat(r.URL.Query())
	cl := getClientFor(cat)

	src, err := parseSrc(r.URL.Query())
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	t, err := addOrGetTorrentHTTPOnly(cl, src)
	if err != nil {
		http.Error(w, "add torrent: "+err.Error(), 400)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	_ = waitForInfo(ctx, t)

	ih := t.InfoHash()
	lastTouch[key(cat, ih)] = time.Now()

	var files []fileEntry
	if t.Info() != nil {
		for i, f := range t.Files() {
			files = append(files, fileEntry{Index: i, Name: f.Path(), Length: f.Length()})
		}
	}
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
	t, err := addOrGetTorrentHTTPOnly(cl, src)
	if err != nil {
		http.Error(w, "add torrent: "+err.Error(), 400)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
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
	_ = json.NewEncoder(w).Encode(files)
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
	t, err := addOrGetTorrentHTTPOnly(cl, src)
	if err != nil {
		http.Error(w, "add torrent: "+err.Error(), 400)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()
	if err := waitForInfo(ctx, t); err != nil {
		http.Error(w, "metadata timeout", http.StatusGatewayTimeout)
		return
	}
	lastTouch[key(cat, t.InfoHash())] = time.Now()

	// pick file
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

	size := f.Length()
	name := f.Path()

	// Range
	var start, end int64
	start, end = 0, size-1
	if rh := r.Header.Get("Range"); rh != "" && strings.HasPrefix(strings.ToLower(rh), "bytes=") {
		parts := strings.SplitN(strings.TrimPrefix(rh, "bytes="), "-", 2)
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

	// Reader drives piece priorities
	reader := f.NewReader()
	defer reader.Close()
	reader.SetReadahead(16 << 20)
	reader.SetResponsive()
	if _, err := reader.Seek(start, io.SeekStart); err != nil {
		http.Error(w, "seek error: "+err.Error(), 500)
		return
	}

	// Headers
	ct := contentTypeForName(name)
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Content-Disposition", fmt.Sprintf("inline; filename=%q", filepath.Base(name)))
	w.Header().Set("Cache-Control", "no-store")
	if start == 0 && end == size-1 {
		w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	} else {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, size))
		w.Header().Set("Content-Length", strconv.FormatInt(length, 10))
		w.WriteHeader(http.StatusPartialContent)
	}

	// Stream
	buf := make([]byte, 256<<10)
	var written int64
	for written < length {
		toRead := int64(len(buf))
		if rem := length - written; rem < toRead {
			toRead = rem
		}
		n, readErr := io.ReadFull(reader, buf[:toRead])
		if n > 0 {
			if _, err := w.Write(buf[:n]); err != nil {
				return
			}
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
			written += int64(n)
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) || errors.Is(readErr, io.ErrUnexpectedEOF) {
				return
			}
			time.Sleep(250 * time.Millisecond)
		}
	}
	log.Printf("[%s] streamed %s (file %d) %d-%d", cat, t.Name(), fidx, start, end)
}

/* ===== housekeeping ===== */

func enableCORS(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Content-Type")
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
						log.Printf("dropping idle torrent [%s] %s", cat, tt.Name())
						tt.Drop()
						delete(lastTouch, k)
					}
				}
			}
			clientsMu.Unlock()
		}

		// size-based crude cap: check total size under dataRoot
		if cacheMax > 0 && dirSize(dataRoot) > cacheMax {
			// drop the oldest touch across all categories
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
								log.Printf("evicting [%s] %s to honor CACHE_MAX_BYTES", cat, tt.Name())
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

/* ===== main ===== */

func main() {

	defer func() {
		if r := recover(); r != nil {
			log.Printf("PANIC: %v", r)
		}
	}()

	_ = godotenv.Load(".env")

	dataRoot = getenvDefault("TORRENT_DATA_ROOT", "./vod-cache")
	_ = os.MkdirAll(dataRoot, 0o755)

	if v := os.Getenv("CACHE_MAX_BYTES"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			cacheMax = n
		}
	}
	if v := os.Getenv("CACHE_EVICT_TTL"); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			evictTTL = d
		}
	}

	go janitor()

	mux := http.NewServeMux()
	mux.HandleFunc("/add", handleAdd)       // ?magnet=...&cat=movie
	mux.HandleFunc("/files", handleFiles)   // ?magnet=...&cat=tv
	mux.HandleFunc("/stream", handleStream) // ?magnet=...&cat=anime&fileIndex=0

	addr := getenvDefault("LISTEN", ":4001")
	log.Printf("VOD listening on %s, root=%s", addr, dataRoot)
	if err := http.ListenAndServe(addr, mux); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
