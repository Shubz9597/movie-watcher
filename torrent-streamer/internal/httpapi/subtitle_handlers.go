package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
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
	langs := []string{"en"}
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

// handleSubtitleExternal fetches and serves an external subtitle as VTT
// GET /subtitles/external?source=opensub&id=12345&lang=en
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

func setOpenSubtitlesAPIKey(apiKey string) {
	openSubtitlesCredential.mu.Lock()
	openSubtitlesCredential.apiKey = strings.TrimSpace(apiKey)
	openSubtitlesCredential.mu.Unlock()
}
