package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/anacrolix/torrent"

	"torrent-streamer/internal/buffer"
	"torrent-streamer/internal/config"
	"torrent-streamer/internal/middleware"
	"torrent-streamer/internal/torrentx"
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
	Size          int64  `json:"size"`
	NumFiles      int    `json:"numFiles"`
	BestIndex     int    `json:"bestIndex"`
	BestName      string `json:"bestName"`
	BestLength    int64  `json:"bestLength"`
	SelectedIndex *int   `json:"selectedIndex,omitempty"`
	LastTouched   string `json:"lastTouched"`
	BufferedAhead int64  `json:"bufferedAhead"`
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

func RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/add", handleAdd)
	mux.HandleFunc("/files", handleFiles)
	mux.HandleFunc("/prefetch", handlePrefetch)
	mux.HandleFunc("/stream", handleStream)
	mux.HandleFunc("/stats", handleStats)
	mux.HandleFunc("/buffer/state", handleBufferState)
	mux.HandleFunc("/buffer/info", handleBufferInfo)
}

func parseCat(q url.Values) string {
	c := strings.ToLower(strings.TrimSpace(q.Get("cat")))
	switch c {
	case "movie", "tv", "anime":
		return c
	case "":
		return "misc"
	default:
		return c
	}
}

func handleAdd(w http.ResponseWriter, r *http.Request) {
	middleware.EnableCORS(w)
	cat := parseCat(r.URL.Query())
	cl := torrentx.GetClientFor(cat)

	src, err := torrentx.ParseSrc(r.URL.Query())
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	t, err := torrentx.AddOrGetTorrent(cl, src)
	if strings.HasPrefix(src, "magnet:") {
		u, h, s, o := torrentx.CountTrackers(src)
		log.Printf("[trackers] udp=%d http=%d https=%d other=%d", u, h, s, o)
	}
	if err != nil {
		http.Error(w, "add torrent: "+err.Error(), 400)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), config.WaitMetadata())
	defer cancel()
	metaStart := time.Now()
	_ = torrentx.WaitForInfo(ctx, t)
	metaMs := time.Since(metaStart).Milliseconds()

	ih := t.InfoHash()
	log.Printf("[add] connected cat=%s ih=%s name=%q files=%d", cat, ih.HexString(), t.Name(), len(t.Files()))
	torrentx.SetLastTouch(cat, ih)

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
	middleware.EnableCORS(w)
	cat := parseCat(r.URL.Query())
	cl := torrentx.GetClientFor(cat)

	src, err := torrentx.ParseSrc(r.URL.Query())
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	t, err := torrentx.AddOrGetTorrent(cl, src)
	if err != nil {
		http.Error(w, "add torrent: "+err.Error(), 400)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), config.WaitMetadata())
	defer cancel()
	if err := torrentx.WaitForInfo(ctx, t); err != nil {
		http.Error(w, "metadata timeout", http.StatusGatewayTimeout)
		return
	}
	torrentx.SetLastTouch(cat, t.InfoHash())

	var files []fileEntry
	for i, f := range t.Files() {
		files = append(files, fileEntry{Index: i, Name: f.Path(), Length: f.Length()})
	}
	log.Printf("[files] cat=%s ih=%s name=%q files=%d", cat, t.InfoHash().HexString(), t.Name(), len(files))
	_ = json.NewEncoder(w).Encode(files)
}

func handlePrefetch(w http.ResponseWriter, r *http.Request) {
	middleware.EnableCORS(w)
	cat := parseCat(r.URL.Query())
	cl := torrentx.GetClientFor(cat)

	src, err := torrentx.ParseSrc(r.URL.Query())
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	t, err := torrentx.AddOrGetTorrent(cl, src)
	if err != nil {
		http.Error(w, "add torrent: "+err.Error(), 400)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), config.WaitMetadata())
	defer cancel()
	metaStart := time.Now()
	if err := torrentx.WaitForInfo(ctx, t); err != nil {
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
	torrentx.SetLastTouch(cat, t.InfoHash())

	f, fidx := torrentx.ChooseBestVideoFile(t)
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
	got := torrentx.Prebuffer(rd, min64(config.PrebufferBytes(), 512<<10), config.PrebufferTimeout())
	log.Printf("[prefetch] cat=%s ih=%s file=%d bytes=%d in %s",
		cat, t.InfoHash().HexString(), fidx, got, time.Since(readStart))

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
	defer func() {
		if rec := recover(); rec != nil {
			log.Printf("[stream] panic recovered: %v", rec)
		}
	}()

	middleware.EnableCORS(w)
	cat := parseCat(r.URL.Query())
	cl := torrentx.GetClientFor(cat)

	src, err := torrentx.ParseSrc(r.URL.Query())
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	t, err := torrentx.AddOrGetTorrent(cl, src)
	if strings.HasPrefix(src, "magnet:") {
		u, h, s, o := torrentx.CountTrackers(src)
		log.Printf("[trackers] udp=%d http=%d https=%d other=%d", u, h, s, o)
	}
	if err != nil {
		http.Error(w, "add torrent: "+err.Error(), http.StatusBadRequest)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), config.WaitMetadata())
	defer cancel()
	metaStart := time.Now()
	if err := torrentx.WaitForInfo(ctx, t); err != nil {
		log.Printf("[stream] cat=%s name=%q metadata TIMEOUT after %s", cat, t.Name(), time.Since(metaStart))
		http.Error(w, "metadata timeout", http.StatusGatewayTimeout)
		return
	}
	torrentx.SetLastTouch(cat, t.InfoHash())

	var f *torrent.File
	fidx := 0
	if idxStr := r.URL.Query().Get("fileIndex"); idxStr != "" {
		if n, _ := strconv.Atoi(idxStr); n >= 0 && n < len(t.Files()) {
			f = t.Files()[n]
			fidx = n
		}
	}
	if f == nil {
		f, fidx = torrentx.ChooseBestVideoFile(t)
	}
	if f == nil {
		http.Error(w, "no playable file in torrent", http.StatusNotFound)
		return
	}
	torrentx.SetLastFileIndex(cat, t.InfoHash(), fidx)

	torrentx.IncActive(cat, t.InfoHash())
	defer torrentx.DecActive(cat, t.InfoHash())

	torrentx.SetLastTouch(cat, t.InfoHash())

	k := buffer.Key{Cat: cat, IH: t.InfoHash().HexString(), FIdx: fidx}
	ctl := buffer.Get(k)

	first := buffer.IsFirstHit(k)
	if first {
		var initSec int64
		if torrentx.IsLikely4K(f.Path(), f.Length()) {
			initSec = 12
		} else if f.Length() >= (2 << 30) {
			initSec = 8
		} else {
			initSec = 6
		}
		playSec := initSec
		pauseSec := max64(config.TargetPauseSec(), initSec*6)
		ctl.SetTargetSeconds(playSec, pauseSec)
	} else if torrentx.IsLikely4K(f.Path(), f.Length()) {
		playSec := config.TargetPlay4KSec()
		if playSec <= 0 {
			playSec = 180
		}
		pauseSec := config.TargetPause4KSec()
		if pauseSec <= 0 {
			pauseSec = 600
		}
		ctl.SetTargetSeconds(playSec, pauseSec)
	}

	size := f.Length()
	name := f.Path()

	hadRange := false
	start, end := int64(0), size-1
	if rh := r.Header.Get("Range"); rh != "" {
		if s, e, ok := parseByteRange(rh, size); ok {
			start, end, hadRange = s, e, true
		} else {
			w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", size))
			http.Error(w, "invalid range", http.StatusRequestedRangeNotSatisfiable)
			return
		}
	}
	length := end - start + 1

	isProbe := isProbeRange(start, end)
	if !isProbe {
		ctl.SetState(buffer.StatePlaying)
		ctl.SetPlayhead(start)
	}

	target := ctl.TargetBytes()

	reader := f.NewReader()
	defer reader.Close()
	if _, err := reader.Seek(start, io.SeekStart); err != nil {
		http.Error(w, "seek error: "+err.Error(), http.StatusInternalServerError)
		return
	}
	reader.SetResponsive()
	if isProbe {
		reader.SetReadahead(256 << 10)
	} else {
		reader.SetReadahead(target)
	}

	localWarmMB := config.WarmReadAheadMB()
	if torrentx.IsLikely4K(f.Path(), f.Length()) {
		if config.WarmReadAhead4KMB() > 0 {
			localWarmMB = config.WarmReadAhead4KMB()
		} else if localWarmMB < 64 {
			localWarmMB = 64
		}
	}
	var warmWant int64
	if !isProbe {
		warmWant = min64(target, localWarmMB<<20)
		if warmWant > 256<<10 && length >= 512<<10 {
			warmStart := time.Now()
			got := torrentx.Prebuffer(reader, min64(warmWant, length), config.PrebufferTimeout())
			ctl.UpdateThroughput(got, int64(time.Since(warmStart).Milliseconds()))
			_, _ = reader.Seek(start, io.SeekStart)
		}
	}

	w.Header().Set("X-Buffer-Target-Bytes", strconv.FormatInt(target, 10))
	w.Header().Set("X-Buffered-Ahead-Probe", strconv.FormatInt(buffer.ContiguousAheadPieceExact(t, f, start), 10))

	if warmWant > 0 {
		if _, err := reader.Seek(start, io.SeekStart); err != nil {
			log.Printf("[stream] rewind after prebuffer failed: %v", err)
		}
	}

	w.Header().Set("Content-Type", torrentx.ContentTypeForName(name))
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Content-Disposition", fmt.Sprintf("inline; filename=%q", torrentx.SafeDownloadName(filepath.Base(name))))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-File-Index", strconv.Itoa(fidx))
	w.Header().Set("X-File-Name", filepath.Base(name))

	if hadRange {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, size))
		w.Header().Set("Content-Length", strconv.FormatInt(length, 10))
		w.WriteHeader(http.StatusPartialContent)
	} else {
		w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	}

	if r.Method == http.MethodHead {
		return
	}

	rc := http.NewResponseController(w)
	buf := make([]byte, 256<<10)
	var written int64
	progressEvery := 2 * time.Second
	var lastProg time.Time

	for written < length {
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
			torrentx.SetLastTouch(cat, t.InfoHash())

			if _, err := w.Write(buf[:n]); err != nil {
				if torrentx.ClientGone(err) {
					return
				}
				log.Printf("[stream] client write error: %v", err)
				return
			}
			if err := rc.Flush(); err != nil {
				return
			}
			written += int64(n)
			if time.Since(lastProg) >= progressEvery {
				lastProg = time.Now()
				ctlBytes := ctl.TargetBytes()
				pct := float64(written) / float64(length) * 100
				log.Printf("[stream] progress %0.1f%% (%d/%d) target=%d", pct, written, length, ctlBytes)
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) || errors.Is(readErr, io.ErrUnexpectedEOF) {
				break
			}
			if torrentx.ClientGone(readErr) {
				return
			}
			time.Sleep(200 * time.Millisecond)
		}
	}
	log.Printf("[stream] cat=%s name=%q fileIdx=%d range=%d-%d len=%d target=%d",
		cat, t.Name(), fidx, start, end, written, target)
}

func handleStats(w http.ResponseWriter, r *http.Request) {
	middleware.EnableCORS(w)

	wantCat := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("cat")))
	wantIH := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("infoHash")))

	resp := statsResp{
		UptimeSeconds:   int64(time.Since(startTime()).Seconds()),
		DataRoot:        config.DataRoot(),
		TotalCacheBytes: torrentx.DirSize(config.DataRoot()),
		CacheMaxBytes:   config.CacheMaxBytes(),
		EvictTTL:        config.EvictTTL().String(),
		TrackersMode:    strings.ToLower(config.TrackersMode()),
	}

	var cats []categoryStats

	torrentx.ForEachClient(func(cat string, cl *torrent.Client) {
		if wantCat != "" && wantCat != cat {
			return
		}
		var rows []torrentStat
		for _, t := range cl.Torrents() {
			ih := strings.ToLower(t.InfoHash().HexString())
			if wantIH != "" && !strings.EqualFold(wantIH, ih) {
				continue
			}
			haveInfo := t.Info() != nil
			size := torrentx.TorrentTotalSize(t)
			best, bestIdx := (*torrent.File)(nil), -1
			if haveInfo {
				if bf, idx := torrentx.ChooseBestVideoFile(t); bf != nil {
					best, bestIdx = bf, idx
				}
			}
			var selPtr *int
			if idx, ok := torrentx.GetLastFileIndex(cat, t.InfoHash()); ok {
				sel := idx
				selPtr = &sel
			}
			last := "never"
			if ts, ok := torrentx.GetLastTouch(cat, t.InfoHash()); ok {
				last = ts.Format(time.RFC3339)
			}
			row := torrentStat{
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
				kb := buffer.Key{Cat: cat, IH: t.InfoHash().HexString(), FIdx: bestIdx}
				ctl := buffer.Get(kb)
				row.BufferedAhead = buffer.ContiguousAheadPieceExact(t, best, ctl.Playhead())
				row.TargetAhead = ctl.TargetBytes()
			}
			rows = append(rows, row)
		}
		sort.Slice(rows, func(i, j int) bool {
			li := rows[i].LastTouched
			lj := rows[j].LastTouched
			if li != "never" && lj != "never" {
				return li > lj
			}
			if li != "never" {
				return true
			}
			if lj != "never" {
				return false
			}
			return rows[i].Name < rows[j].Name
		})
		cats = append(cats, categoryStats{Category: cat, Torrents: rows})
	})

	resp.Categories = cats
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

func handleBufferState(w http.ResponseWriter, r *http.Request) {
	middleware.EnableCORS(w)
	q := r.URL.Query()
	cat := parseCat(q)

	cl := torrentx.GetClientFor(cat)
	src, err := torrentx.ParseSrc(q)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	t, err := torrentx.AddOrGetTorrent(cl, src)
	if err != nil {
		http.Error(w, "add torrent: "+err.Error(), 400)
		return
	}
	if err := torrentx.WaitForInfo(r.Context(), t); err != nil {
		http.Error(w, "metadata timeout", http.StatusGatewayTimeout)
		return
	}

	var f *torrent.File
	fidx := 0
	if idxStr := q.Get("fileIndex"); idxStr != "" {
		if n, _ := strconv.Atoi(idxStr); n >= 0 && n < len(t.Files()) {
			f = t.Files()[n]
			fidx = n
		}
	}
	if f == nil {
		if bf, bi := torrentx.ChooseBestVideoFile(t); bf != nil {
			f, fidx = bf, bi
		}
	}
	if f == nil {
		http.Error(w, "no playable file", 404)
		return
	}

	k := buffer.Key{Cat: cat, IH: t.InfoHash().HexString(), FIdx: fidx}
	ctl := buffer.Get(k)

	switch strings.ToLower(q.Get("state")) {
	case "pause":
		ctl.SetState(buffer.StatePaused)
		ctlStart := ctl.Playhead()
		go ctl.StartWarm(cat, t, f, ctlStart)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "state": "paused"})
	case "play":
		ctl.SetState(buffer.StatePlaying)
	default:
		http.Error(w, "state must be pause|play", 400)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func handleBufferInfo(w http.ResponseWriter, r *http.Request) {
	middleware.EnableCORS(w)
	q := r.URL.Query()
	cat := parseCat(q)

	cl := torrentx.GetClientFor(cat)
	src, err := torrentx.ParseSrc(q)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	t, err := torrentx.AddOrGetTorrent(cl, src)
	if err != nil {
		http.Error(w, "add torrent: "+err.Error(), 400)
		return
	}
	if err := torrentx.WaitForInfo(r.Context(), t); err != nil {
		http.Error(w, "metadata timeout", http.StatusGatewayTimeout)
		return
	}

	var f *torrent.File
	fidx := 0
	if idxStr := q.Get("fileIndex"); idxStr != "" {
		if n, _ := strconv.Atoi(idxStr); n >= 0 && n < len(t.Files()) {
			f = t.Files()[n]
			fidx = n
		}
	}
	if f == nil {
		if bf, bi := torrentx.ChooseBestVideoFile(t); bf != nil {
			f, fidx = bf, bi
		}
	}
	if f == nil {
		http.Error(w, "no playable file", 404)
		return
	}

	k := buffer.Key{Cat: cat, IH: t.InfoHash().HexString(), FIdx: fidx}
	ctl := buffer.Get(k)

	if torrentx.IsLikely4K(f.Path(), f.Length()) {
		playSec := config.TargetPlay4KSec()
		if playSec <= 0 {
			playSec = 180
		}
		pauseSec := config.TargetPause4KSec()
		if pauseSec <= 0 {
			pauseSec = 600
		}
		ctl.SetTargetSeconds(playSec, pauseSec)
	}

	if wantsSSE(r) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache, no-transform")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")

		_, _ = io.WriteString(w, "retry: 2000\n\n")
		rc := http.NewResponseController(w)

		write := func() bool {
			out := buildBufferInfoOut(t, f, fidx, ctl)
			b, _ := json.Marshal(out)
			if _, err := fmt.Fprintf(w, "data: %s\n\n", b); err != nil {
				return false
			}
			_ = rc.Flush()
			torrentx.SetLastTouch(cat, t.InfoHash())
			return true
		}
		if !write() {
			return
		}
		tick := time.NewTicker(1 * time.Second)
		defer tick.Stop()
		ping := time.NewTicker(15 * time.Second)
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

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(buildBufferInfoOut(t, f, fidx, ctl))
}

// ===== helpers =====

var startAt = time.Now()

func startTime() time.Time { return startAt }

func isProbeRange(start, end int64) bool {
	const maxProbe = 1 << 10
	if start < 0 || end < start {
		return false
	}
	return (end - start + 1) <= maxProbe
}

func parseByteRange(h string, size int64) (start, end int64, ok bool) {
	h = strings.TrimSpace(strings.ToLower(h))
	if !strings.HasPrefix(h, "bytes=") {
		return 0, 0, false
	}
	spec := strings.TrimPrefix(h, "bytes=")
	parts := strings.Split(spec, ",")
	if len(parts) != 1 {
		return 0, 0, false
	}
	se := strings.SplitN(strings.TrimSpace(parts[0]), "-", 2)
	if se[0] == "" {
		n, err := strconv.ParseInt(se[1], 10, 64)
		if err != nil || n <= 0 {
			return 0, 0, false
		}
		if n > size {
			n = size
		}
		return size - n, size - 1, true
	}
	s, err := strconv.ParseInt(se[0], 10, 64)
	if err != nil || s < 0 || s >= size {
		return 0, 0, false
	}
	var e int64
	if len(se) == 1 || se[1] == "" {
		e = size - 1
	} else {
		e, err = strconv.ParseInt(se[1], 10, 64)
		if err != nil || e < s {
			return 0, 0, false
		}
		if e >= size {
			e = size - 1
		}
	}
	return s, e, true
}

func wantsSSE(r *http.Request) bool {
	if strings.EqualFold(r.URL.Query().Get("sse"), "1") {
		return true
	}
	return strings.Contains(strings.ToLower(r.Header.Get("Accept")), "text/event-stream")
}

func min64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}
func max64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

func buildBufferInfoOut(t *torrent.Torrent, f *torrent.File, fidx int, ctl *buffer.Controller) map[string]any {
	return map[string]any{
		"state":           string(ctl.State()),
		"playheadBytes":   ctl.Playhead(),
		"targetBytes":     ctl.TargetBytes(),
		"targetAheadSec":  ctl.TargetAheadSeconds(),
		"rollingBps":      nil,
		"contiguousAhead": buffer.ContiguousAheadPieceExact(t, f, ctl.Playhead()),
		"fileIndex":       fidx,
		"fileLength":      f.Length(),
	}
}
