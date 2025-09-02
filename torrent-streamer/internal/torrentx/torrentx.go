package torrentx

import (
	"context"
	"errors"
	"fmt"
	"log"
	"mime"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/anacrolix/torrent"
	"github.com/anacrolix/torrent/metainfo"

	"torrent-streamer/internal/config"
)

var (
	clientsMu sync.Mutex
	clients   = make(map[string]*torrent.Client) // cat -> client
	lastTouch = make(map[string]time.Time)       // key(cat:infohash) -> time

	activeMu      sync.Mutex
	activeStreams = map[string]int{} // key(cat:ih) -> concurrent readers

	lastFileIndex = make(map[string]int) // key(cat:infohash) -> last streamed file index
)

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
	}
}

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
		if last, ok := lastTouch[k]; ok && time.Since(last) < g {
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

func ParseSrc(q url.Values) (string, error) {
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

func srcFromID(id string) (string, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return "", errors.New("empty id")
	}
	if strings.HasPrefix(id, "magnet:") {
		return sanitizeMagnet(id), nil
	}
	if len(id) == 40 && strings.IndexFunc(id, func(r rune) bool {
		return !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F'))
	}) == -1 {
		return sanitizeMagnet("magnet:?xt=urn:btih:" + strings.ToUpper(id)), nil
	}
	if len(id) == 32 {
		return sanitizeMagnet("magnet:?xt=urn:btih:" + strings.ToUpper(id)), nil
	}
	return "", fmt.Errorf("unrecognized id: %q", id)
}

func GetClientFor(cat string) *torrent.Client {
	cat = validCat(cat)
	clientsMu.Lock()
	defer clientsMu.Unlock()

	if c, ok := clients[cat]; ok {
		return c
	}
	dir := filepath.Join(config.DataRoot(), cat)
	_ = os.MkdirAll(dir, 0o755)
	dir = winLongPath(dir)

	cfg := torrent.NewDefaultClientConfig()
	cfg.DataDir = dir
	cfg.DisableTCP = false
	cfg.DisableUTP = true
	cfg.Seed = false
	cfg.NoUpload = false

	c, err := torrent.NewClient(cfg)
	if err != nil {
		log.Fatalf("client(%s) init: %v", cat, err)
	}
	clients[cat] = c
	log.Printf("[init] client(%s) dataDir=%s trackersMode=%s", cat, dir, config.TrackersMode())
	return c
}

func AddOrGetTorrent(cl *torrent.Client, src string) (*torrent.Torrent, error) {
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

func TorrentTotalSize(t *torrent.Torrent) int64 {
	if t.Info() == nil {
		return 0
	}
	var s int64
	for _, f := range t.Files() {
		s += f.Length()
	}
	return s
}

func Prebuffer(r torrent.Reader, want int64, timeout time.Duration) int64 {
	if want <= 0 {
		return 0
	}
	buf := make([]byte, 256<<10)
	var done int64
	deadline := time.Now().Add(timeout)
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
			time.Sleep(200 * time.Millisecond)
		}
	}
	return done
}

func SetLastTouch(cat string, ih metainfo.Hash) { lastTouch[key(cat, ih)] = time.Now() }
func GetLastTouch(cat string, ih metainfo.Hash) (time.Time, bool) {
	v, ok := lastTouch[key(cat, ih)]
	return v, ok
}
func ClearTouch(cat string, ih metainfo.Hash) { delete(lastTouch, key(cat, ih)) }

func LastFileIndexKey(cat string, ih metainfo.Hash) string   { return key(cat, ih) }
func SetLastFileIndex(cat string, ih metainfo.Hash, idx int) { lastFileIndex[key(cat, ih)] = idx }
func GetLastFileIndex(cat string, ih metainfo.Hash) (int, bool) {
	v, ok := lastFileIndex[key(cat, ih)]
	return v, ok
}

func EnsureTorrentForKey(cat, id string) error {
	cat = validCat(cat)
	cl := GetClientFor(cat)
	src, err := srcFromID(id)
	if err != nil {
		return err
	}
	t, err := AddOrGetTorrent(cl, src)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = WaitForInfo(ctx, t)
	SetLastTouch(cat, t.InfoHash())
	return nil
}

func StopTorrentForKey(cat, id string) {
	cat = validCat(cat)
	clientsMu.Lock()
	cl := clients[cat]
	clientsMu.Unlock()
	if cl == nil {
		return
	}
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
		} else if strings.EqualFold(t.InfoHash().HexString(), id) {
			match = true
		}
		if match {
			if !mayDrop(cat, t.InfoHash()) {
				log.Printf("[watch] skip drop (guard) [%s] %s ih=%s",
					cat, t.Name(), t.InfoHash().HexString())
				return
			}
			log.Printf("[watch] dropping [%s] %s ih=%s", cat, t.Name(), t.InfoHash().HexString())
			t.Drop()
			delete(lastTouch, key(cat, t.InfoHash()))
			delete(lastFileIndex, key(cat, t.InfoHash()))
			return
		}
	}
}

func ForEachClient(fn func(cat string, c *torrent.Client)) {
	clientsMu.Lock()
	defer clientsMu.Unlock()
	cats := make([]string, 0, len(clients))
	for c := range clients {
		cats = append(cats, c)
	}
	sort.Strings(cats)
	for _, cat := range cats {
		fn(cat, clients[cat])
	}
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
	var op *net.OpError
	if errors.As(err, &op) {
		if se, ok := op.Err.(*os.SyscallError); ok && runtime.GOOS == "windows" {
			if se.Err == syscall.WSAECONNRESET || se.Err == syscall.WSAECONNABORTED {
				return true
			}
		}
	}
	return false
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
