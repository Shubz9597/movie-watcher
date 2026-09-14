package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"torrent-streamer/internal/config"
	"torrent-streamer/internal/middleware"
	"torrent-streamer/internal/subtitles"
	"torrent-streamer/internal/torrentx"
)

var openSubtitlesCredential = struct {
	mu     sync.RWMutex
	apiKey string
}{}

// SubtitleListResponse is the response for /subtitles/list
type SubtitleListResponse struct {
	Source             string                  `json:"source"`
	Tracks             []SubtitleTrack         `json:"tracks"`
	FallbackUsed       bool                    `json:"fallbackUsed"`
	ProviderConfigured bool                    `json:"providerConfigured"`
	Message            string                  `json:"message,omitempty"`
	Torrent            []torrentx.SubtitleFile `json:"torrent,omitempty"`
	External           []subtitles.SubResult   `json:"external,omitempty"`
}

// SubtitleTrack is the only shape Electron needs, regardless of source.
type SubtitleTrack struct {
	Source           string `json:"source"`
	Lang             string `json:"lang"`
	Label            string `json:"label"`
	URL              string `json:"url"`
	FileName         string `json:"fileName"`
	Format           string `json:"format,omitempty"`
	Release          string `json:"release,omitempty"`
	DownloadCount    int    `json:"downloadCount,omitempty"`
	HearingImpaired  bool   `json:"hearingImpaired,omitempty"`
	Trusted          bool   `json:"trusted,omitempty"`
	MovieHashMatched bool   `json:"movieHashMatched,omitempty"`
}

// RegisterSubtitleRoutes registers subtitle-related HTTP handlers
func RegisterSubtitleRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/subtitles/configure", handleSubtitleConfiguration)
	mux.HandleFunc("/subtitles/list", handleSubtitleList)
	mux.HandleFunc("/subtitles/torrent", handleSubtitleTorrent)
	mux.HandleFunc("/subtitles/external", handleSubtitleExternal)
	// M1.4.7: local subtitle import (mobile + desktop share the surface).
	mux.HandleFunc("/subtitles/import", handleSubtitleImport)
}

func handleSubtitleConfiguration(w http.ResponseWriter, r *http.Request) {
	middleware.EnableCORS(w)
	if r.Method == http.MethodOptions {
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var request struct {
		APIKey string `json:"apiKey"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10))
	if err := decoder.Decode(&request); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	apiKey := strings.TrimSpace(request.APIKey)
	if apiKey == "" || len(apiKey) > 1024 {
		http.Error(w, "invalid api key", http.StatusBadRequest)
		return
	}
	setOpenSubtitlesAPIKey(apiKey)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

// handleSubtitleList returns the complete English catalog from both the
// selected torrent and OpenSubtitles. The two lookups run concurrently so a
// slow torrent metadata read cannot unnecessarily delay provider results.
// GET /subtitles/list?magnet=...&cat=movie&fileIndex=0&imdbId=tt1234567
func handleSubtitleList(w http.ResponseWriter, r *http.Request) {
	middleware.EnableCORS(w)
	if r.Method == http.MethodOptions {
		return
	}
	q := r.URL.Query()
	cat := parseCat(q)
	langs := splitCSV(q.Get("langs"))
	if len(langs) == 0 {
		langs = []string{"en"}
	}
	if len(langs) > 5 {
		http.Error(w, "choose at most five subtitle languages", http.StatusBadRequest)
		return
	}
	for _, lang := range langs {
		if !subtitleLanguagePattern.MatchString(lang) {
			http.Error(w, "invalid subtitle language", http.StatusBadRequest)
			return
		}
	}
	providerKey := openSubtitlesAPIKey()

	resp := SubtitleListResponse{
		Source:             "none",
		Tracks:             []SubtitleTrack{},
		Torrent:            []torrentx.SubtitleFile{},
		External:           []subtitles.SubResult{},
		ProviderConfigured: providerKey != "",
	}

	type torrentCatalog struct {
		files  []torrentx.SubtitleFile
		tracks []SubtitleTrack
	}
	type externalCatalog struct {
		results []subtitles.SubResult
		tracks  []SubtitleTrack
		err     error
	}
	torrentCh := make(chan torrentCatalog, 1)
	externalCh := make(chan externalCatalog, 1)
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	go func() {
		part := torrentCatalog{}
		src, parseErr := torrentx.ParseSrc(q)
		if parseErr != nil || src == "" {
			torrentCh <- part
			return
		}
		t, addErr := torrentx.AddOrGetTorrent(torrentx.GetClientFor(cat), src)
		if addErr != nil {
			log.Printf("[subtitles] torrent unavailable: %v", addErr)
			torrentCh <- part
			return
		}
		if metadataErr := torrentx.WaitForInfo(ctx, t); metadataErr != nil {
			log.Printf("[subtitles] torrent metadata unavailable: %v", metadataErr)
			torrentCh <- part
			return
		}
		torrentx.TouchTorrent(cat, t)
		videoIndex, parseIndexErr := strconv.Atoi(q.Get("fileIndex"))
		if parseIndexErr != nil || videoIndex < 0 || videoIndex >= len(t.Files()) {
			_, videoIndex = torrentx.ChooseBestVideoFile(t)
		}
		part.files = filterTorrentLanguages(torrentx.FindSubtitleFilesForVideo(t, videoIndex), langs)
		for i := range part.files {
			part.files[i].Path = buildSubtitleTorrentURL(q, part.files[i].Index)
			lang := part.files[i].Lang
			if lang == "und" {
				lang = "en"
			}
			part.tracks = append(part.tracks, SubtitleTrack{
				Source: "torrent", Lang: lang, Label: part.files[i].Name,
				URL: part.files[i].Path, FileName: part.files[i].Name, Format: part.files[i].Ext,
			})
		}
		torrentCh <- part
	}()

	go func() {
		part := externalCatalog{}
		if providerKey == "" {
			part.err = errors.New("OpenSubtitles API key is not configured")
			externalCh <- part
			return
		}
		part.results, part.err = subtitles.FetchFromOpenSub(ctx, subtitles.SearchQuery{
			IMDBID: q.Get("imdbId"), TMDBID: q.Get("tmdbId"), Title: q.Get("title"),
			Year: intParam(q, "year"), Season: intParam(q, "season"), Episode: intParam(q, "episode"),
			Langs: langs,
		}, providerKey)
		if part.err == nil {
			for i := range part.results {
				part.results[i].URL = buildSubtitleExternalURL("opensub", part.results[i].ID, part.results[i].Lang)
				format := strings.TrimPrefix(strings.ToLower(filepath.Ext(part.results[i].FileName)), ".")
				if format == "" {
					format = "srt"
				}
				part.tracks = append(part.tracks, SubtitleTrack{
					Source: "opensub", Lang: part.results[i].Lang, Label: part.results[i].Label,
					URL: part.results[i].URL, FileName: part.results[i].FileName, Format: format,
					Release: part.results[i].Release, DownloadCount: part.results[i].DownloadCount,
					HearingImpaired: part.results[i].HearingImpaired, Trusted: part.results[i].Trusted,
					MovieHashMatched: part.results[i].MovieHashMatched,
				})
			}
		}
		externalCh <- part
	}()

	torrentPart, externalPart := <-torrentCh, <-externalCh
	resp.Torrent, resp.External = torrentPart.files, externalPart.results
	resp.Tracks = append(resp.Tracks, torrentPart.tracks...)
	resp.Tracks = append(resp.Tracks, externalPart.tracks...)
	resp.FallbackUsed = len(torrentPart.tracks) == 0 && len(externalPart.tracks) > 0
	switch {
	case len(torrentPart.tracks) > 0 && len(externalPart.tracks) > 0:
		resp.Source = "mixed"
	case len(torrentPart.tracks) > 0:
		resp.Source = "torrent"
	case len(externalPart.tracks) > 0:
		resp.Source = "opensub"
	}
	if externalPart.err != nil {
		log.Printf("[subtitles] opensub search error: %v", externalPart.err)
		var rateErr *subtitles.RateLimitError
		if providerKey == "" {
			resp.Message = "OpenSubtitles API key is not configured"
		} else if errors.As(externalPart.err, &rateErr) {
			resp.Message = rateErr.Error()
		} else {
			resp.Message = "OpenSubtitles could not be reached. Retry in a moment."
		}
	} else if len(resp.Tracks) == 0 {
		resp.Message = "No English subtitles found"
	}
	writeSubtitleList(w, resp)
}

// handleSubtitleTorrent serves a subtitle file from the torrent as VTT
// GET /subtitles/torrent?magnet=...&cat=movie&fileIndex=2
func handleSubtitleTorrent(w http.ResponseWriter, r *http.Request) {
	middleware.EnableCORS(w)
	q := r.URL.Query()
	cat := parseCat(q)

	src, err := torrentx.ParseSrc(q)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	fileIndexStr := q.Get("fileIndex")
	fileIndex, err := strconv.Atoi(fileIndexStr)
	if err != nil || fileIndex < 0 {
		http.Error(w, "invalid fileIndex", http.StatusBadRequest)
		return
	}

	cl := torrentx.GetClientFor(cat)
	t, err := torrentx.AddOrGetTorrent(cl, src)
	if err != nil {
		http.Error(w, "add torrent: "+err.Error(), http.StatusBadRequest)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), config.WaitMetadata())
	defer cancel()
	if err := torrentx.WaitForInfo(ctx, t); err != nil {
		http.Error(w, "metadata timeout", http.StatusGatewayTimeout)
		return
	}
	torrentx.TouchTorrent(cat, t)

	if fileIndex >= len(t.Files()) {
		http.Error(w, "fileIndex out of range", http.StatusBadRequest)
		return
	}

	f := t.Files()[fileIndex]

	// Verify it's a text subtitle file. Binary VobSub .sub files require their
	// paired .idx and cannot be safely served through this single-file route.
	ext := strings.TrimPrefix(strings.ToLower(filepath.Ext(f.Path())), ".")
	validExts := map[string]bool{"srt": true, "vtt": true, "ass": true, "ssa": true}
	if !validExts[ext] {
		http.Error(w, "not a subtitle file", http.StatusBadRequest)
		return
	}

	// Read the subtitle file
	reader := f.NewReader()
	defer reader.Close()
	reader.SetResponsive()

	// Prebuffer the entire subtitle (they're small)
	_ = torrentx.Prebuffer(reader, f.Length(), 30*time.Second)
	_, _ = reader.Seek(0, io.SeekStart)

	data, err := io.ReadAll(io.LimitReader(reader, 5<<20)) // 5MB limit
	if err != nil {
		http.Error(w, "failed to read subtitle: "+err.Error(), http.StatusInternalServerError)
		return
	}

	content := string(data)

	output := content
	contentType := "text/plain; charset=utf-8"
	if ext == "srt" {
		output = subtitles.SRTtoVTT(content)
		contentType = "text/vtt; charset=utf-8"
	} else if ext == "vtt" || strings.HasPrefix(strings.TrimSpace(content), "WEBVTT") {
		contentType = "text/vtt; charset=utf-8"
	} else if ext == "ass" || ext == "ssa" {
		contentType = "text/x-ssa; charset=utf-8"
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "public, max-age=3600")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	_, _ = w.Write([]byte(output))
}

// subtitleImportRoot resolves (and lazily creates) the directory imported
// subtitle files are stored in. It prefers the configured subtitle cache
// directory and falls back to the OS temp dir in dev setups without one.
func subtitleImportRoot() (string, error) {
	base := os.Getenv("SUB_CACHE_DIR")
	if base == "" {
		base = filepath.Join(os.TempDir(), "torwatch-subcache")
	}
	dir := filepath.Join(base, "imported")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

// Imported-subtitle retention bounds: files live at most importRetention and
// the whole import cache stays under importCacheMaxBytes (oldest evicted
// first). The sweep runs inline on every import — the directory is bounded
// and tiny, so this is cheaper than a background janitor.
const (
	importRetention     = 7 * 24 * time.Hour
	importCacheMaxBytes = 64 << 20
)

// sweepSubtitleImports enforces the retention bounds. Best-effort: a sweep
// failure never fails an import.
func sweepSubtitleImports(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	type imported struct {
		name    string
		size    int64
		modTime time.Time
	}
	var files []imported
	var total int64
	cutoff := time.Now().Add(-importRetention)
	for _, entry := range entries {
		if entry.IsDir() || !subtitleImportPattern.MatchString(entry.Name()) {
			continue
		}
		info, statErr := entry.Info()
		if statErr != nil {
			continue
		}
		if info.ModTime().Before(cutoff) {
			_ = os.Remove(filepath.Join(dir, entry.Name()))
			continue
		}
		files = append(files, imported{name: entry.Name(), size: info.Size(), modTime: info.ModTime()})
		total += info.Size()
	}
	// Enforce the total cap, oldest first.
	sort.Slice(files, func(i, j int) bool { return files[i].modTime.Before(files[j].modTime) })
	for _, f := range files {
		if total <= importCacheMaxBytes {
			break
		}
		if os.Remove(filepath.Join(dir, f.name)) == nil {
			total -= f.size
		}
	}
}

// handleSubtitleImport accepts ONE text subtitle file (multipart form field
// "file", <= 4 MiB, srt/vtt/ass/ssa) from the local household and stores it
// server-side. The response carries an opaque serving URL usable exactly
// like an OpenSubtitles/torrent track URL — players (VLC included) load it at
// runtime without a playback restart. No authentication by design: the LAN
// household is the trust boundary (same as /subtitles/list).
func handleSubtitleImport(w http.ResponseWriter, r *http.Request) {
	middleware.EnableCORS(w)
	if r.Method == http.MethodOptions {
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// ParseMultipartForm's argument only limits RAM; bound the entire body
	// as well so oversized uploads cannot spill arbitrarily to disk.
	r.Body = http.MaxBytesReader(w, r.Body, (4<<20)+(64<<10))
	if err := r.ParseMultipartForm(4 << 20); err != nil {
		http.Error(w, "invalid upload (max 4 MiB)", http.StatusBadRequest)
		return
	}
	defer r.MultipartForm.RemoveAll()
	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "missing file field", http.StatusBadRequest)
		return
	}
	defer file.Close()

	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(header.Filename), "."))
	switch ext {
	case "srt", "vtt", "ass", "ssa":
	default:
		http.Error(w, "unsupported subtitle format: "+ext, http.StatusBadRequest)
		return
	}
	if header.Size > 4<<20 {
		http.Error(w, "subtitle file exceeds 4 MiB", http.StatusBadRequest)
		return
	}

	data, err := io.ReadAll(io.LimitReader(file, (4<<20)+1))
	if err != nil || len(data) == 0 || len(data) > 4<<20 {
		http.Error(w, "could not read subtitle", http.StatusBadRequest)
		return
	}

	dir, err := subtitleImportRoot()
	if err != nil {
		http.Error(w, "could not store subtitle", http.StatusInternalServerError)
		return
	}
	id, err := randomTokenID()
	if err != nil {
		http.Error(w, "could not store subtitle", http.StatusInternalServerError)
		return
	}
	name := id + "." + ext
	if err := os.WriteFile(filepath.Join(dir, name), data, 0o644); err != nil {
		http.Error(w, "could not store subtitle", http.StatusInternalServerError)
		return
	}
	sweepSubtitleImports(dir)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"ok":       "true",
		"id":       name,
		"fileName": header.Filename,
		"url":      "/subtitles/external?source=import&id=" + url.QueryEscape(name),
		"format":   ext,
	})
}

// subtitleImportPattern constrains import ids to the exact server-generated
// shape (32 hex chars + known extension): no traversal, no user-controlled
// paths.
var subtitleImportPattern = regexp.MustCompile(`^([a-f0-9]{32})\.(srt|vtt|ass|ssa)$`)
var subtitleLanguagePattern = regexp.MustCompile(`^[a-z]{2,3}(?:-[a-z]{2})?$`)

// handleSubtitleExternal fetches and serves an external subtitle as VTT
// GET /subtitles/external?source=opensub&id=12345&lang=en
// GET /subtitles/external?source=import&id=<server-generated id>
func handleSubtitleExternal(w http.ResponseWriter, r *http.Request) {
	middleware.EnableCORS(w)
	q := r.URL.Query()

	source := q.Get("source")
	id := q.Get("id")

	if id == "" {
		http.Error(w, "missing id parameter", http.StatusBadRequest)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	var vtt string
	var err error

	switch source {
	case "opensub":
		apiKey := openSubtitlesAPIKey()
		if apiKey == "" {
			http.Error(w, "OpenSubtitles API key not configured", http.StatusServiceUnavailable)
			return
		}
		vtt, err = subtitles.DownloadOpenSubSubtitle(ctx, id, apiKey)
	case "import":
		match := subtitleImportPattern.FindStringSubmatch(id)
		if match == nil {
			http.Error(w, "invalid subtitle id", http.StatusBadRequest)
			return
		}
		dir, err := subtitleImportRoot()
		if err != nil {
			http.Error(w, "subtitle store unavailable", http.StatusServiceUnavailable)
			return
		}
		data, readErr := os.ReadFile(filepath.Join(dir, match[0]))
		if readErr != nil {
			http.Error(w, "subtitle expired or not found", http.StatusNotFound)
			return
		}
		vtt = string(data)
		switch match[2] {
		case "srt":
			vtt = subtitles.SRTtoVTT(vtt)
		case "vtt":
			// already VTT
		case "ass", "ssa":
			// ASS/SSA served as-is: VLC renders the original styling.
			w.Header().Set("Content-Type", "text/x-ssa; charset=utf-8")
			w.Header().Set("Cache-Control", "public, max-age=3600")
			w.Header().Set("Access-Control-Allow-Origin", "*")
			_, _ = w.Write([]byte(vtt))
			return
		}
	default:
		http.Error(w, "unsupported subtitle source: "+source, http.StatusBadRequest)
		return
	}

	if err != nil {
		log.Printf("[subtitles] download error (%s/%s): %v", source, id, err)
		var rateErr *subtitles.RateLimitError
		if errors.As(err, &rateErr) {
			seconds := int(rateErr.RetryAfter.Round(time.Second).Seconds())
			if seconds < 1 {
				seconds = 1
			}
			w.Header().Set("Retry-After", strconv.Itoa(seconds))
			http.Error(w, rateErr.Error(), http.StatusTooManyRequests)
			return
		}
		http.Error(w, "failed to download subtitle: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/vtt; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	_, _ = w.Write([]byte(vtt))
}

// Helper functions

func buildSubtitleTorrentURL(q url.Values, fileIndex int) string {
	params := url.Values{}
	for _, key := range []string{"magnet", "src", "infoHash", "cat"} {
		if value := q.Get(key); value != "" {
			params.Set(key, value)
		}
	}
	params.Set("fileIndex", strconv.Itoa(fileIndex))
	return "/subtitles/torrent?" + params.Encode()
}

func buildSubtitleExternalURL(source, id, lang string) string {
	params := url.Values{"source": {source}, "id": {id}, "lang": {lang}}
	return "/subtitles/external?" + params.Encode()
}

func writeSubtitleList(w http.ResponseWriter, resp SubtitleListResponse) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

func splitCSV(value string) []string {
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.ToLower(strings.TrimSpace(part))
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

func filterTorrentLanguages(files []torrentx.SubtitleFile, preferred []string) []torrentx.SubtitleFile {
	if len(preferred) == 0 {
		return files
	}
	wanted := make(map[string]bool, len(preferred))
	for _, lang := range preferred {
		wanted[lang] = true
	}
	out := make([]torrentx.SubtitleFile, 0, len(files))
	for _, file := range files {
		if wanted[file.Lang] {
			out = append(out, file)
		}
	}
	return out
}

func intParam(q url.Values, key string) int {
	value, err := strconv.Atoi(q.Get(key))
	if err != nil || value < 0 {
		return 0
	}
	return value
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func openSubtitlesAPIKey() string {
	openSubtitlesCredential.mu.RLock()
	apiKey := openSubtitlesCredential.apiKey
	openSubtitlesCredential.mu.RUnlock()
	if apiKey != "" {
		return apiKey
	}
	return firstNonEmpty(os.Getenv("OPENSUB_API_KEY"), os.Getenv("OS_KEY"))
}

// randomTokenID returns a 32-char hex identifier for imported subtitle
// files (also the serving id; never a filesystem path).
func randomTokenID() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

func setOpenSubtitlesAPIKey(apiKey string) {
	openSubtitlesCredential.mu.Lock()
	openSubtitlesCredential.apiKey = strings.TrimSpace(apiKey)
	openSubtitlesCredential.mu.Unlock()
}
