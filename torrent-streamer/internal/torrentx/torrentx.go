package torrentx

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"mime"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/anacrolix/torrent"
	"github.com/anacrolix/torrent/metainfo"

	"torrent-streamer/internal/config"
)

var (
	clientsMu     sync.Mutex
	clients       = make(map[string]*torrent.Client) // cat -> client
	stateMu       sync.RWMutex
	lastTouch     = make(map[string]time.Time) // key(cat:infohash) -> time
	manifestWrite = make(map[string]time.Time)
	manifestMu    sync.Mutex

	activeMu      sync.Mutex
	activeStreams = map[string]int{} // key(cat:ih) -> concurrent readers

)

// CacheEntry is the durable record used by the janitor. It lets eviction find
// completed torrent data even after the Go process has restarted.
type CacheEntry struct {
	Category    string    `json:"category"`
	InfoHash    string    `json:"infoHash"`
	Name        string    `json:"name"`
	Paths       []string  `json:"paths"`
	Size        int64     `json:"size"`
	LastTouched time.Time `json:"lastTouched"`
}

func Init() {
	_ = os.MkdirAll(config.DataRoot(), 0o755)
}

func CloseAllClients() {
	clientsMu.Lock()
	defer clientsMu.Unlock()
	for cat, c := range clients {
		if c != nil {
			log.Printf("[boot] closing client[%s]", cat)
			c.Close()
		}
		delete(clients, cat)
	}
}

func validCat(c string) string {
	c = strings.ToLower(strings.TrimSpace(c))
	switch c {
	case "movie", "tv", "anime", "misc":
		return c
	default:
		return "misc"
	}
}

// Category maps a source kind (movie|tv|anime) onto the valid torrent
// client category, exposed for the offline-download prep worker.
func Category(kind string) string { return validCat(kind) }

// InfoHashFromSrc parses the infohash of a literal magnet URI without adding
// the torrent (used to hold active-reference protection before addition).
func InfoHashFromSrc(src string) (metainfo.Hash, error) {
	src = strings.TrimSpace(src)
	if !strings.HasPrefix(strings.ToLower(src), "magnet:") {
		return metainfo.Hash{}, errors.New("only literal magnet URIs are accepted")
	}
	ih := mustParseMagnet(src)
	if ih == (metainfo.Hash{}) {
		return metainfo.Hash{}, errors.New("invalid magnet URI")
	}
	return ih, nil
}

func key(cat string, ih metainfo.Hash) string { return validCat(cat) + ":" + ih.HexString() }

func IncActive(cat string, ih metainfo.Hash) {
	k := key(cat, ih)
	activeMu.Lock()
	activeStreams[k]++
	activeMu.Unlock()
}
func DecActive(cat string, ih metainfo.Hash) {
	k := key(cat, ih)
	activeMu.Lock()
	if n := activeStreams[k]; n > 1 {
		activeStreams[k] = n - 1
	} else {
		delete(activeStreams, k)
	}
	activeMu.Unlock()
}

func mayDrop(cat string, ih metainfo.Hash) bool {
	k := key(cat, ih)

	activeMu.Lock()
	n := activeStreams[k]
	activeMu.Unlock()
	if n > 0 {
		log.Printf("[guard] skip drop (activeReaders=%d) [%s] %s", n, cat, ih.HexString())
		return false
	}
	if g := config.WatchDropGuard(); g > 0 {
		stateMu.RLock()
		last, ok := lastTouch[k]
		stateMu.RUnlock()
		if ok && time.Since(last) < g {
			log.Printf("[guard] skip drop (recent=%s<%s) [%s] %s",
				time.Since(last).Truncate(time.Second), g, cat, ih.HexString())
			return false
		}
	}
	return true
}

// trackers
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
	switch strings.ToLower(config.TrackersMode()) {
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

func sanitizeMagnet(raw string) string {
	if !strings.HasPrefix(raw, "magnet:") {
		return raw
	}
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	q := u.Query()
	mode := strings.ToLower(strings.TrimSpace(config.TrackersMode()))
	if mode == "" {
		mode = "udp"
	}
	orig := q["tr"]
	q.Del("tr")
	keep := func(tr string) bool {
		trL := strings.ToLower(tr)
		switch mode {
		case "udp":
			return strings.HasPrefix(trL, "udp://")
		case "none":
			return false
		default:
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

func CountTrackers(raw string) (udp, http, https, other int) {
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

// validInfoHash accepts a 40-char hex or 32-char base32 BitTorrent v1 hash.
func validInfoHash(value string) bool {
	value = strings.ToUpper(strings.TrimSpace(value))
	if len(value) == 40 {
		return strings.IndexFunc(value, func(r rune) bool {
			return !((r >= '0' && r <= '9') || (r >= 'A' && r <= 'F'))
		}) == -1
	}
	if len(value) == 32 {
		return strings.IndexFunc(value, func(r rune) bool {
			return !((r >= 'A' && r <= 'Z') || (r >= '2' && r <= '7'))
		}) == -1
	}
	return false
}

func ParseSrc(q url.Values) (string, error) {
	if s := q.Get("magnet"); s != "" {
		if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(s)), "magnet:") {
			return "", errors.New("magnet parameter must contain a literal magnet URI")
		}
		result := sanitizeMagnet(s)
		if mustParseMagnet(result) == (metainfo.Hash{}) {
			return "", errors.New("invalid magnet URI")
		}
		// Debug: log what we're receiving and returning
		srcPreview := s
		if len(srcPreview) > 60 {
			srcPreview = srcPreview[:60] + "..."
		}
		resultPreview := result
		if len(resultPreview) > 60 {
			resultPreview = resultPreview[:60] + "..."
		}
		log.Printf("[ParseSrc] magnet param: %q -> %q", srcPreview, resultPreview)
		return result, nil
	}
	if s := q.Get("src"); s != "" {
		if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(s)), "magnet:") {
			return "", errors.New("src parameter must contain a literal magnet URI")
		}
		result := sanitizeMagnet(s)
		if mustParseMagnet(result) == (metainfo.Hash{}) {
			return "", errors.New("invalid magnet URI")
		}
		return result, nil
	}
	if ih := strings.TrimSpace(q.Get("infoHash")); ih != "" {
		if validInfoHash(ih) {
			return sanitizeMagnet("magnet:?xt=urn:btih:" + strings.ToUpper(ih)), nil
		}
		return "", errors.New("invalid infoHash")
	}
	return "", errors.New("missing magnet/src/infoHash")
}

func GetClientFor(cat string) (*torrent.Client, error) {
	cat = validCat(cat)
	clientsMu.Lock()
	defer clientsMu.Unlock()

	if c, ok := clients[cat]; ok {
		return c, nil
	}
	dir := filepath.Join(config.DataRoot(), cat)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("create torrent data directory: %w", err)
	}
	dir = winLongPath(dir)

	cfg := torrent.NewDefaultClientConfig()
	cfg.DataDir = dir
	cfg.DisableTCP = false
	cfg.DisableUTP = true
	cfg.Seed = false
	cfg.NoUpload = false
	// Each category owns a client. Random ports avoid collisions by default;
	// a configured port is the base of four consecutive category ports.
	cfg.ListenPort = 0
	if raw := strings.TrimSpace(os.Getenv("TORRENT_LISTEN_PORT")); raw != "" {
		port, err := strconv.Atoi(raw)
		if err != nil || port < 0 || port > 65532 {
			return nil, errors.New("TORRENT_LISTEN_PORT must be 0 or a base port from 1 to 65532")
		}
		if port > 0 {
			cfg.ListenPort = port + map[string]int{"movie": 0, "tv": 1, "anime": 2, "misc": 3}[cat]
		}
	}

	c, err := torrent.NewClient(cfg)
	if err != nil {
		return nil, fmt.Errorf("initialize torrent client for %s: %w", cat, err)
	}
	clients[cat] = c
	log.Printf("[init] client(%s) dataDir=%s trackersMode=%s", cat, dir, config.TrackersMode())
	return c, nil
}

func AddOrGetTorrent(cl *torrent.Client, src string) (*torrent.Torrent, error) {
	src = strings.TrimSpace(src)
	srcPreview := src
	if len(srcPreview) > 60 {
		srcPreview = srcPreview[:60] + "..."
	}
	log.Printf("[AddOrGetTorrent] src=%q (len=%d)", srcPreview, len(src))

	if !strings.HasPrefix(strings.ToLower(src), "magnet:") {
		return nil, errors.New("only literal magnet URIs are accepted")
	}
	ih := mustParseMagnet(src)
	if ih == (metainfo.Hash{}) {
		return nil, errors.New("invalid magnet URI")
	}
	if t, ok := cl.Torrent(ih); ok {
		log.Printf("[AddOrGetTorrent] torrent already exists: %s", ih.HexString())
		return t, nil
	}
	log.Printf("[AddOrGetTorrent] adding magnet URI")
	t, err := cl.AddMagnet(src)
	if err != nil {
		return nil, err
	}
	if tiers := buildTrackerTiers(); len(tiers) != 0 {
		t.AddTrackers(tiers)
	}
	return t, nil
}

func WaitForInfo(ctx context.Context, t *torrent.Torrent) error {
	select {
	case <-t.GotInfo():
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func ChooseBestVideoFile(t *torrent.Torrent) (*torrent.File, int) {
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

func ContentTypeForName(name string) string {
	ct := mime.TypeByExtension(strings.ToLower(filepath.Ext(name)))
	if ct != "" {
		return ct
	}
	return "application/octet-stream"
}

func Prebuffer(ctx context.Context, r torrent.Reader, want int64, timeout time.Duration) int64 {
	if want <= 0 {
		return 0
	}
	readCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	r.SetContext(readCtx)
	defer r.SetContext(ctx)
	r.SetResponsive()
	buf := make([]byte, 256<<10)
	var done int64
	for done < want && readCtx.Err() == nil {
		toRead := min(int64(len(buf)), want-done)
		n, err := r.Read(buf[:toRead])
		done += int64(n)
		if err != nil || n == 0 {
			break
		}
	}
	return done
}

// TouchTorrent records recent use in memory and periodically persists enough
// metadata for safe, exact-file eviction after a service restart.
func TouchTorrent(cat string, t *torrent.Torrent) {
	if t == nil {
		return
	}
	cat = validCat(cat)
	ih := t.InfoHash()
	now := time.Now()
	k := key(cat, ih)
	stateMu.Lock()
	lastTouch[k] = now
	if t.Info() == nil {
		stateMu.Unlock()
		return
	}
	lastWrite := manifestWrite[k]
	if now.Sub(lastWrite) < time.Minute {
		stateMu.Unlock()
		return
	}
	manifestWrite[k] = now
	stateMu.Unlock()
	entry := CacheEntry{
		Category:    cat,
		InfoHash:    ih.HexString(),
		Name:        t.Name(),
		LastTouched: now,
	}
	root, err := filepath.Abs(filepath.Join(config.DataRoot(), cat))
	if err != nil {
		return
	}
	for _, file := range t.Files() {
		if _, err := safeCachePath(root, file.Path()); err != nil {
			log.Printf("[janitor] refusing cache manifest path [%s] %s: %v", cat, file.Path(), err)
			return
		}
		entry.Paths = append(entry.Paths, file.Path())
		entry.Size += file.Length()
	}
	if err := writeCacheEntry(entry); err != nil {
		log.Printf("[janitor] cache manifest write failed [%s] %s: %v", cat, ih.HexString(), err)
	}
}

func cacheManifestDir() string {
	return filepath.Join(config.DataRoot(), ".mw-cache")
}

func cacheManifestPath(cat, infoHash string) string {
	return filepath.Join(cacheManifestDir(), validCat(cat)+"-"+strings.ToUpper(infoHash)+".json")
}

func writeCacheEntry(entry CacheEntry) error {
	manifestMu.Lock()
	defer manifestMu.Unlock()
	if err := os.MkdirAll(cacheManifestDir(), 0o755); err != nil {
		return err
	}
	data, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(cacheManifestDir(), ".entry-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err = tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	dst := cacheManifestPath(entry.Category, entry.InfoHash)
	if err = os.Rename(tmpName, dst); err == nil {
		return nil
	}
	// Windows cannot always replace an existing destination atomically.
	if removeErr := os.Remove(dst); removeErr != nil && !os.IsNotExist(removeErr) {
		return err
	}
	return os.Rename(tmpName, dst)
}

// ListCacheEntries returns valid persisted cache records and ignores malformed
// records rather than allowing them to influence filesystem deletion.
func ListCacheEntries() ([]CacheEntry, error) {
	items, err := os.ReadDir(cacheManifestDir())
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	entries := make([]CacheEntry, 0, len(items))
	for _, item := range items {
		if item.IsDir() || !strings.HasSuffix(strings.ToLower(item.Name()), ".json") {
			continue
		}
		data, readErr := os.ReadFile(filepath.Join(cacheManifestDir(), item.Name()))
		if readErr != nil {
			continue
		}
		var entry CacheEntry
		if json.Unmarshal(data, &entry) != nil || !validInfoHashHex(entry.InfoHash) || entry.Category != validCat(entry.Category) || entry.LastTouched.IsZero() || len(entry.Paths) == 0 {
			continue
		}
		entries = append(entries, entry)
	}
	return entries, nil
}

func validInfoHashHex(value string) bool {
	if len(value) != 40 {
		return false
	}
	for _, r := range value {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')) {
			return false
		}
	}
	return true
}

func removeCacheManifest(cat string, ih metainfo.Hash) error {
	err := os.Remove(cacheManifestPath(cat, ih.HexString()))
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

func clearTorrentState(cat string, ih metainfo.Hash) {
	stateMu.Lock()
	delete(lastTouch, key(cat, ih))
	delete(manifestWrite, key(cat, ih))
	stateMu.Unlock()
}

// EvictTorrentData drops an inactive torrent and removes only the exact files
// declared by its metainfo. Every path is resolved and checked against the
// category cache root; no recursive deletion or untrusted glob is used.
func EvictTorrentData(cat string, t *torrent.Torrent) (int64, error) {
	if t == nil || t.Info() == nil {
		return 0, errors.New("torrent metadata unavailable")
	}
	ih := t.InfoHash()
	if !mayDrop(cat, ih) {
		return 0, errors.New("torrent is pinned or active")
	}

	root, err := filepath.Abs(filepath.Join(config.DataRoot(), validCat(cat)))
	if err != nil {
		return 0, err
	}
	paths := make([]string, 0, len(t.Files()))
	for _, file := range t.Files() {
		filePaths, pathErr := cacheStoragePaths(root, file.Path())
		if pathErr != nil {
			return 0, pathErr
		}
		paths = append(paths, filePaths...)
	}

	t.Drop()
	clearTorrentState(cat, ih)
	freed, err := removeTorrentFiles(root, paths)
	if err != nil {
		return freed, err
	}
	return freed, removeCacheManifest(cat, ih)
}

// EvictCachedInfoHash evicts either a currently loaded torrent or an orphaned
// cache record left by an earlier process. In both cases only manifest-listed
// files underneath the category root are eligible for deletion.
func EvictCachedInfoHash(cat string, ih metainfo.Hash) (int64, error) {
	cat = validCat(cat)
	if !mayDrop(cat, ih) {
		return 0, errors.New("torrent is pinned or active")
	}
	clientsMu.Lock()
	cl := clients[cat]
	clientsMu.Unlock()
	if cl != nil {
		if t, ok := cl.Torrent(ih); ok {
			return EvictTorrentData(cat, t)
		}
	}

	entries, err := ListCacheEntries()
	if err != nil {
		return 0, err
	}
	for _, entry := range entries {
		if entry.Category != cat || !strings.EqualFold(entry.InfoHash, ih.HexString()) {
			continue
		}
		root, pathErr := filepath.Abs(filepath.Join(config.DataRoot(), cat))
		if pathErr != nil {
			return 0, pathErr
		}
		paths := make([]string, 0, len(entry.Paths))
		for _, raw := range entry.Paths {
			filePaths, safeErr := cacheStoragePaths(root, raw)
			if safeErr != nil {
				return 0, safeErr
			}
			paths = append(paths, filePaths...)
		}
		freed, removeErr := removeTorrentFiles(root, paths)
		if removeErr != nil {
			return freed, removeErr
		}
		clearTorrentState(cat, ih)
		return freed, removeCacheManifest(cat, ih)
	}
	return 0, errors.New("cache manifest not found")
}

// Default torrent storage renames incomplete data to <path>.part. Both forms
// belong to the declared file, including manifests written by older releases.
func cacheStoragePaths(root, relative string) ([]string, error) {
	path, err := safeCachePath(root, relative)
	if err != nil {
		return nil, err
	}
	part, err := safeCachePath(root, relative+".part")
	if err != nil {
		return nil, err
	}
	return []string{path, part}, nil
}

func safeCachePath(root, relative string) (string, error) {
	root = filepath.Clean(root)
	candidate := filepath.Clean(filepath.FromSlash(relative))
	if !filepath.IsAbs(candidate) {
		candidate = filepath.Clean(filepath.Join(root, candidate))
	}
	rel, err := filepath.Rel(root, candidate)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) || filepath.IsAbs(rel) {
		return "", fmt.Errorf("torrent path escapes cache root: %q", relative)
	}
	return candidate, nil
}

func removeTorrentFiles(root string, paths []string) (int64, error) {
	var freed int64
	dirs := make(map[string]struct{})
	var errs []error
	for _, path := range paths {
		safe, err := safeCachePath(root, path)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		if info, statErr := os.Stat(safe); statErr == nil && !info.IsDir() {
			freed += info.Size()
		} else if statErr != nil && !os.IsNotExist(statErr) {
			errs = append(errs, statErr)
			continue
		}
		if err := removeFileWithRetry(safe); err != nil && !os.IsNotExist(err) {
			errs = append(errs, err)
			continue
		}
		for dir := filepath.Dir(safe); dir != root; dir = filepath.Dir(dir) {
			dirs[dir] = struct{}{}
			if parent := filepath.Dir(dir); parent == dir {
				break
			}
		}
	}

	ordered := make([]string, 0, len(dirs))
	for dir := range dirs {
		ordered = append(ordered, dir)
	}
	sort.Slice(ordered, func(i, j int) bool { return len(ordered[i]) > len(ordered[j]) })
	for _, dir := range ordered {
		_ = os.Remove(dir) // remove empty parents only; shared/non-empty dirs remain
	}
	return freed, errors.Join(errs...)
}

func removeFileWithRetry(path string) error {
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		err = os.Remove(path)
		if err == nil || os.IsNotExist(err) {
			return err
		}
		time.Sleep(time.Duration(attempt+1) * 100 * time.Millisecond)
	}
	return err
}

func DirSize(root string) int64 {
	var total int64
	_ = filepath.Walk(root, func(_ string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			total += info.Size()
		}
		return nil
	})
	return total
}

func IsLikely4K(name string, size int64) bool {
	n := strings.ToLower(name)
	if strings.Contains(n, "2160p") || strings.Contains(n, "4k") || strings.Contains(n, "uhd") {
		return true
	}
	return size >= 8<<30
}

func SafeDownloadName(name string) string {
	repl := strings.NewReplacer("<", "", ">", "", ":", "", `"`, "", "/", "", `\`, "", "|", "", "?", "", "*", "")
	n := repl.Replace(name)
	n = strings.Trim(n, " .")
	if len(n) == 0 {
		n = "video"
	}
	if len(n) > 120 {
		n = n[:120]
	}
	return n
}

func ClientGone(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	if errors.Is(err, net.ErrClosed) {
		return true
	}
	s := err.Error()
	if strings.Contains(s, "broken pipe") || strings.Contains(s, "reset by peer") {
		return true
	}
	return socketDisconnected(err)
}

func mustParseMagnet(src string) metainfo.Hash {
	if strings.HasPrefix(src, "magnet:") {
		m, err := metainfo.ParseMagnetUri(src)
		if err == nil && m.InfoHash != (metainfo.Hash{}) {
			return m.InfoHash
		}
	}
	return metainfo.Hash{}
}

func winLongPath(p string) string {
	if os.PathSeparator != '\\' {
		return p
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		abs = p
	}
	if strings.HasPrefix(abs, `\\?\`) {
		return abs
	}
	if strings.HasPrefix(abs, `\\`) {
		return `\\?\UNC\` + strings.TrimPrefix(abs, `\\`)
	}
	return `\\?\` + abs
}

// Passthroughs for guards used by janitor
func CanDrop(cat string, ih metainfo.Hash) bool { return mayDrop(cat, ih) }

// SubtitleFile represents a subtitle file in a torrent
type SubtitleFile struct {
	Index  int    `json:"index"`
	Path   string `json:"path"`
	Name   string `json:"name"`
	Length int64  `json:"length"`
	Lang   string `json:"lang"`
	Ext    string `json:"ext"` // "srt", "vtt", "ass", "ssa"
}

// FindSubtitleFiles returns all subtitle files found in the torrent
func FindSubtitleFiles(t *torrent.Torrent) []SubtitleFile {
	if t.Info() == nil {
		return nil
	}

	subtitleExts := map[string]bool{
		".srt": true,
		".vtt": true,
		".ass": true,
		".ssa": true,
	}

	var subs []SubtitleFile
	for i, f := range t.Files() {
		ext := strings.ToLower(filepath.Ext(f.Path()))
		if !subtitleExts[ext] {
			continue
		}

		name := filepath.Base(f.Path())
		subs = append(subs, SubtitleFile{
			Index:  i,
			Path:   f.Path(),
			Name:   name,
			Length: f.Length(),
			Lang:   DetectLanguage(name),
			Ext:    strings.TrimPrefix(ext, "."),
		})
	}
	return subs
}

var seasonEpisodePattern = regexp.MustCompile(`(?i)s(\d{1,2})[\s._-]*e(\d{1,3})`)

// FindSubtitleFilesForVideo limits torrent sidecars to the selected video.
// This matters for season packs: offering an S01E08 subtitle while S01E02 is
// playing is worse than falling back to a provider. A single-video torrent is
// allowed to use any included subtitle because generic names such as
// "English.srt" are common in movie releases.
func FindSubtitleFilesForVideo(t *torrent.Torrent, videoIndex int) []SubtitleFile {
	all := FindSubtitleFiles(t)
	if len(all) == 0 || t.Info() == nil || videoIndex < 0 || videoIndex >= len(t.Files()) {
		return all
	}

	videoExts := map[string]bool{".mp4": true, ".webm": true, ".m4v": true, ".mov": true, ".mkv": true}
	videoCount := 0
	for _, file := range t.Files() {
		if videoExts[strings.ToLower(filepath.Ext(file.Path()))] {
			videoCount++
		}
	}

	videoPath := strings.ToLower(filepath.ToSlash(t.Files()[videoIndex].Path()))
	matched := make([]SubtitleFile, 0, len(all))

	for _, sub := range all {
		if subtitleMatchesVideoPath(sub.Path, videoPath, videoCount) {
			matched = append(matched, sub)
		}
	}

	return matched
}

func subtitleMatchesVideoPath(subtitlePath, videoPath string, videoCount int) bool {
	videoPath = strings.ToLower(filepath.ToSlash(videoPath))
	subtitlePath = strings.ToLower(filepath.ToSlash(subtitlePath))
	videoStem := strings.TrimSuffix(filepath.Base(videoPath), filepath.Ext(videoPath))
	subtitleStem := strings.TrimSuffix(filepath.Base(subtitlePath), filepath.Ext(subtitlePath))

	// The usual movie/show.en.srt convention.
	if subtitleStem == videoStem || strings.HasPrefix(subtitleStem, videoStem+".") || strings.HasPrefix(subtitleStem, videoStem+"_") || strings.HasPrefix(subtitleStem, videoStem+"-") {
		return true
	}

	// Season pack subtitles may live in a Subs/S01E02/English.srt tree.
	videoEpisode := seasonEpisodePattern.FindStringSubmatch(videoPath)
	if len(videoEpisode) == 3 {
		subtitleEpisode := seasonEpisodePattern.FindStringSubmatch(subtitlePath)
		if len(subtitleEpisode) == 3 && subtitleEpisode[1] == videoEpisode[1] && subtitleEpisode[2] == videoEpisode[2] {
			return true
		}
	}

	return videoCount <= 1
}

// DetectLanguage parses language code from a subtitle filename
func DetectLanguage(filename string) string {
	lower := strings.ToLower(filename)

	// Common language patterns in subtitle filenames
	langPatterns := []struct {
		patterns []string
		code     string
	}{
		{[]string{"english", "eng", ".en.", "_en_", "_en.", ".en_", "[en]", "(en)"}, "en"},
		{[]string{"hindi", "hin", ".hi.", "_hi_", "_hi.", ".hi_", "[hi]", "(hi)"}, "hi"},
		{[]string{"spanish", "spa", "espanol", ".es.", "_es_", "_es.", ".es_", "[es]", "(es)"}, "es"},
		{[]string{"french", "fra", "francais", ".fr.", "_fr_", "_fr.", ".fr_", "[fr]", "(fr)"}, "fr"},
		{[]string{"german", "deu", "deutsch", ".de.", "_de_", "_de.", ".de_", "[de]", "(de)"}, "de"},
		{[]string{"italian", "ita", "italiano", ".it.", "_it_", "_it.", ".it_", "[it]", "(it)"}, "it"},
		{[]string{"portuguese", "por", ".pt.", "_pt_", "_pt.", ".pt_", "[pt]", "(pt)"}, "pt"},
		{[]string{"russian", "rus", ".ru.", "_ru_", "_ru.", ".ru_", "[ru]", "(ru)"}, "ru"},
		{[]string{"japanese", "jpn", ".ja.", "_ja_", "_ja.", ".ja_", "[ja]", "(ja)", ".jp.", "_jp_"}, "ja"},
		{[]string{"korean", "kor", ".ko.", "_ko_", "_ko.", ".ko_", "[ko]", "(ko)", ".kr.", "_kr_"}, "ko"},
		{[]string{"chinese", "chi", "zho", ".zh.", "_zh_", "_zh.", ".zh_", "[zh]", "(zh)", ".cn.", "_cn_"}, "zh"},
		{[]string{"arabic", "ara", ".ar.", "_ar_", "_ar.", ".ar_", "[ar]", "(ar)"}, "ar"},
		{[]string{"dutch", "nld", ".nl.", "_nl_", "_nl.", ".nl_", "[nl]", "(nl)"}, "nl"},
		{[]string{"polish", "pol", ".pl.", "_pl_", "_pl.", ".pl_", "[pl]", "(pl)"}, "pl"},
		{[]string{"turkish", "tur", ".tr.", "_tr_", "_tr.", ".tr_", "[tr]", "(tr)"}, "tr"},
		{[]string{"vietnamese", "vie", ".vi.", "_vi_", "_vi.", ".vi_", "[vi]", "(vi)"}, "vi"},
		{[]string{"thai", "tha", ".th.", "_th_", "_th.", ".th_", "[th]", "(th)"}, "th"},
		{[]string{"indonesian", "ind", ".id.", "_id_", "_id.", ".id_", "[id]", "(id)"}, "id"},
		{[]string{"malay", "msa", ".ms.", "_ms_", "_ms.", ".ms_", "[ms]", "(ms)"}, "ms"},
	}

	for _, lp := range langPatterns {
		for _, p := range lp.patterns {
			if strings.Contains(lower, p) {
				return lp.code
			}
		}
	}

	// Default to unknown
	return "und"
}
