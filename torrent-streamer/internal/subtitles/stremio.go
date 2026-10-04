package subtitles

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// Stremio's hosted OpenSubtitles addon needs no API key: it is the fallback
// when the configured OpenSubtitles key is missing, refused (episode searches
// return 403) or its download endpoint fails. Results are looked up by IMDb id
// (plus season/episode), so episodes match exactly.

var (
	stremioSubtitlesBase = "https://opensubtitles-v3.strem.io"
	stremioHTTP          = &http.Client{Timeout: 15 * time.Second}

	// Subtitle file URLs seen in search results, by id. Downloads only fetch
	// these, never a URL a client supplies.
	stremioURLsMu sync.Mutex
	stremioURLs   = map[string]stremioURL{}
)

// stremioUserAgent identifies TorWatch: Cloudflare-fronted services answer
// Go's default "Go-http-client" agent with 403.
const stremioUserAgent = "TorWatch/1.0"

type stremioURL struct {
	url     string
	expires time.Time
}

// ErrNoIMDbID means the Stremio fallback cannot search this title.
var ErrNoIMDbID = errors.New("subtitle fallback needs an IMDb id")

// FetchFromStremio searches Stremio's OpenSubtitles addon.
func FetchFromStremio(ctx context.Context, query SearchQuery) ([]SubResult, error) {
	imdb := strings.TrimSpace(query.IMDBID)
	if imdb == "" {
		return nil, ErrNoIMDbID
	}
	if !strings.HasPrefix(imdb, "tt") {
		imdb = "tt" + imdb
	}
	path := "/subtitles/movie/" + url.PathEscape(imdb) + ".json"
	if query.Season > 0 && query.Episode > 0 {
		path = fmt.Sprintf("/subtitles/series/%s:%d:%d.json", url.PathEscape(imdb), query.Season, query.Episode)
	}
	base := stremioSubtitlesBase
	if override := os.Getenv("TORWATCH_STREMIO_SUBTITLES_URL"); override != "" {
		base = override
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(base, "/")+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", stremioUserAgent)
	resp, err := stremioHTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("stremio subtitles: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("stremio subtitles: status %d", resp.StatusCode)
	}
	var payload struct {
		Subtitles []struct {
			ID          string `json:"id"`
			URL         string `json:"url"`
			Lang        string `json:"lang"`
			FileName    string `json:"subtitleFileName"`
			ReleaseName string `json:"movieReleaseName"`
		} `json:"subtitles"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&payload); err != nil {
		return nil, fmt.Errorf("stremio subtitles: decode: %w", err)
	}
	wanted := map[string]bool{}
	for _, lang := range query.Langs {
		if code := normalizeLang(lang); code != "" {
			wanted[code] = true
		}
	}
	now := time.Now()
	results := make([]SubResult, 0, len(payload.Subtitles))
	stremioURLsMu.Lock()
	defer stremioURLsMu.Unlock()
	for id, entry := range stremioURLs {
		if now.After(entry.expires) {
			delete(stremioURLs, id)
		}
	}
	for _, sub := range payload.Subtitles {
		lang := normalizeLang(sub.Lang)
		if sub.ID == "" || !trustedStremioSubtitleURL(sub.URL) || (len(wanted) > 0 && !wanted[lang]) {
			continue
		}
		stremioURLs[sub.ID] = stremioURL{url: sub.URL, expires: now.Add(12 * time.Hour)}
		fileName := sub.FileName
		if fileName == "" {
			fileName = sub.ReleaseName + ".srt"
		}
		results = append(results, SubResult{
			Source: "stremio", ID: sub.ID, Lang: lang, Label: langName(lang),
			FileName: fileName, Release: sub.ReleaseName,
		})
	}
	return results, nil
}

// trustedStremioSubtitleURL limits downloads to Stremio's subtitle hosts.
func trustedStremioSubtitleURL(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	return host == "strem.io" || strings.HasSuffix(host, ".strem.io")
}

// DownloadStremioSubtitle fetches a subtitle found by FetchFromStremio and
// returns it as WebVTT.
func DownloadStremioSubtitle(ctx context.Context, id string) (string, error) {
	key := "stremio:" + id
	subCacheMu.RLock()
	if cached, ok := subCache[key]; ok && time.Since(cached.fetched) < cacheTTL {
		subCacheMu.RUnlock()
		return cached.vtt, nil
	}
	subCacheMu.RUnlock()

	stremioURLsMu.Lock()
	entry, ok := stremioURLs[id]
	stremioURLsMu.Unlock()
	if !ok || time.Now().After(entry.expires) {
		return "", errors.New("subtitle expired; search again")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, entry.url, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", stremioUserAgent)
	resp, err := stremioHTTP.Do(req)
	if err != nil {
		return "", fmt.Errorf("stremio subtitle download: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("stremio subtitle download: status %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20+1))
	if err != nil {
		return "", err
	}
	if len(data) == 0 || len(data) > 4<<20 {
		return "", errors.New("stremio subtitle download: empty or oversized file")
	}
	text := string(data)
	if !strings.HasPrefix(strings.TrimSpace(strings.TrimPrefix(text, "\ufeff")), "WEBVTT") {
		text = SRTtoVTT(text)
	}
	subCacheMu.Lock()
	putSubtitleLocked(key, text, time.Now())
	subCacheMu.Unlock()
	return text, nil
}
