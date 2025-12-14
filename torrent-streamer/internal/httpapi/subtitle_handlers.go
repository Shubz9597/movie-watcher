package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"torrent-streamer/internal/config"
	"torrent-streamer/internal/middleware"
	"torrent-streamer/internal/subtitles"
	"torrent-streamer/internal/torrentx"
)

// SubtitleListResponse is the response for /subtitles/list
type SubtitleListResponse struct {
	Torrent  []torrentx.SubtitleFile `json:"torrent"`
	External []subtitles.SubResult   `json:"external"`
}

// RegisterSubtitleRoutes registers subtitle-related HTTP handlers
func RegisterSubtitleRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/subtitles/list", handleSubtitleList)
	mux.HandleFunc("/subtitles/torrent", handleSubtitleTorrent)
	mux.HandleFunc("/subtitles/external", handleSubtitleExternal)
}

// handleSubtitleList returns available subtitles from both torrent and external sources
// GET /subtitles/list?magnet=...&cat=movie&imdbId=tt1234567&langs=en,hi
func handleSubtitleList(w http.ResponseWriter, r *http.Request) {
	middleware.EnableCORS(w)
	q := r.URL.Query()
	cat := parseCat(q)
	imdbID := q.Get("imdbId")
	langsStr := q.Get("langs")

	var langs []string
	if langsStr != "" {
		langs = strings.Split(langsStr, ",")
	}

	resp := SubtitleListResponse{
		Torrent:  []torrentx.SubtitleFile{},
		External: []subtitles.SubResult{},
	}

	// Try to get torrent subtitles
	src, err := torrentx.ParseSrc(q)
	if err == nil && src != "" {
		cl := torrentx.GetClientFor(cat)
		t, err := torrentx.AddOrGetTorrent(cl, src)
		if err == nil {
			ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
			defer cancel()
			if err := torrentx.WaitForInfo(ctx, t); err == nil {
				torrentx.SetLastTouch(cat, t.InfoHash())
				resp.Torrent = torrentx.FindSubtitleFiles(t)

				// Build URLs for torrent subtitles
				for i := range resp.Torrent {
					resp.Torrent[i].Path = buildSubtitleTorrentURL(q, resp.Torrent[i].Index)
				}
			}
		}
	}

	// If we have an IMDB ID, search external sources
	if imdbID != "" {
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()

		// Try Subdl first (free, no API key)
		subdlResults, err := subtitles.FetchFromSubdl(ctx, imdbID, langs)
		if err != nil {
			log.Printf("[subtitles] subdl error: %v", err)
		} else {
			for _, sub := range subdlResults {
				sub.URL = buildSubtitleExternalURL("subdl", sub.ID, sub.Lang)
				resp.External = append(resp.External, sub)
			}
		}

		// If Subdl didn't return results or we want more, try OpenSubtitles
		openSubKey := os.Getenv("OPENSUB_API_KEY")
		if len(resp.External) == 0 && openSubKey != "" {
			osResults, err := subtitles.FetchFromOpenSub(ctx, imdbID, langs, openSubKey)
			if err != nil {
				log.Printf("[subtitles] opensub error: %v", err)
			} else {
				for _, sub := range osResults {
					sub.URL = buildSubtitleExternalURL("opensub", sub.ID, sub.Lang)
					resp.External = append(resp.External, sub)
				}
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
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
	torrentx.SetLastTouch(cat, t.InfoHash())

	if fileIndex >= len(t.Files()) {
		http.Error(w, "fileIndex out of range", http.StatusBadRequest)
		return
	}

	f := t.Files()[fileIndex]

	// Verify it's a subtitle file
	ext := strings.ToLower(strings.TrimPrefix(strings.ToLower(f.Path()[len(f.Path())-4:]), "."))
	validExts := map[string]bool{"srt": true, "vtt": true, "ass": true, "ssa": true, "sub": true}
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

	// Convert to VTT if needed
	var vtt string
	if strings.HasPrefix(strings.TrimSpace(content), "WEBVTT") {
		vtt = content
	} else {
		vtt = subtitles.SRTtoVTT(content)
	}

	w.Header().Set("Content-Type", "text/vtt; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	_, _ = w.Write([]byte(vtt))
}

// handleSubtitleExternal fetches and serves an external subtitle as VTT
// GET /subtitles/external?source=subdl&id=12345&lang=en
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
	case "subdl":
		vtt, err = subtitles.DownloadSubdlSubtitle(ctx, id)
	case "opensub":
		apiKey := os.Getenv("OPENSUB_API_KEY")
		if apiKey == "" {
			http.Error(w, "OpenSubtitles API key not configured", http.StatusServiceUnavailable)
			return
		}
		vtt, err = subtitles.DownloadOpenSubSubtitle(ctx, id, apiKey)
	default:
		http.Error(w, "unknown source: "+source, http.StatusBadRequest)
		return
	}

	if err != nil {
		log.Printf("[subtitles] download error (%s/%s): %v", source, id, err)
		http.Error(w, "failed to download subtitle: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/vtt; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	_, _ = w.Write([]byte(vtt))
}

// Helper functions

func buildSubtitleTorrentURL(q map[string][]string, fileIndex int) string {
	params := make([]string, 0)

	if magnet := getFirst(q, "magnet"); magnet != "" {
		params = append(params, "magnet="+magnet)
	}
	if src := getFirst(q, "src"); src != "" {
		params = append(params, "src="+src)
	}
	if infoHash := getFirst(q, "infoHash"); infoHash != "" {
		params = append(params, "infoHash="+infoHash)
	}
	if cat := getFirst(q, "cat"); cat != "" {
		params = append(params, "cat="+cat)
	}

	params = append(params, "fileIndex="+strconv.Itoa(fileIndex))

	return "/subtitles/torrent?" + strings.Join(params, "&")
}

func buildSubtitleExternalURL(source, id, lang string) string {
	return "/subtitles/external?source=" + source + "&id=" + id + "&lang=" + lang
}

func getFirst(q map[string][]string, key string) string {
	if vals, ok := q[key]; ok && len(vals) > 0 {
		return vals[0]
	}
	return ""
}

