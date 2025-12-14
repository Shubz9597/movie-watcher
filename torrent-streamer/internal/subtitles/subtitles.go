package subtitles

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

// SubResult represents a subtitle search result from external sources
type SubResult struct {
	Source   string `json:"source"`   // "subdl" or "opensub"
	ID       string `json:"id"`       // unique identifier for download
	Lang     string `json:"lang"`     // ISO 639-1 language code
	Label    string `json:"label"`    // display label
	URL      string `json:"url"`      // download URL (internal endpoint)
	FileName string `json:"fileName"` // original filename
}

// Cache for downloaded subtitles (VTT content)
var (
	subCache   = make(map[string]cachedSub)
	subCacheMu sync.RWMutex
)

type cachedSub struct {
	vtt     string
	fetched time.Time
}

const (
	cacheTTL          = 1 * time.Hour
	subdlAPI          = "https://api.subdl.com/api/v1/subtitles"
	openSubAPI        = "https://api.opensubtitles.com/api/v1"
	defaultHTTPTimout = 15 * time.Second
)

// SRTtoVTT converts SRT format subtitles to WebVTT format
func SRTtoVTT(srt string) string {
	// WebVTT header
	var vtt strings.Builder
	vtt.WriteString("WEBVTT\n\n")

	// SRT timestamp format: 00:00:00,000 --> 00:00:00,000
	// VTT timestamp format: 00:00:00.000 --> 00:00:00.000
	// Also need to handle optional cue identifiers (numbers in SRT)

	lines := strings.Split(strings.ReplaceAll(srt, "\r\n", "\n"), "\n")
	
	// Regex to match SRT timestamps
	timeRe := regexp.MustCompile(`(\d{2}:\d{2}:\d{2}),(\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}),(\d{3})`)
	
	// Regex to detect cue numbers (just digits on their own line)
	cueNumRe := regexp.MustCompile(`^\d+$`)

	for i := 0; i < len(lines); i++ {
		line := strings.TrimSpace(lines[i])
		
		// Skip cue numbers
		if cueNumRe.MatchString(line) {
			continue
		}
		
		// Skip empty lines at the start
		if line == "" {
			if vtt.Len() > 10 { // Already have content after header
				vtt.WriteString("\n")
			}
			continue
		}
		
		// Convert timestamps
		if timeRe.MatchString(line) {
			// Replace comma with period in timestamps
			converted := timeRe.ReplaceAllString(line, "$1.$2 --> $3.$4")
			vtt.WriteString(converted)
			vtt.WriteString("\n")
			continue
		}
		
		// Regular subtitle text
		vtt.WriteString(line)
		vtt.WriteString("\n")
	}

	return vtt.String()
}

// FetchFromSubdl searches Subdl API for subtitles (free, no API key required)
func FetchFromSubdl(ctx context.Context, imdbID string, langs []string) ([]SubResult, error) {
	if imdbID == "" {
		return nil, nil
	}

	// Normalize IMDB ID
	if !strings.HasPrefix(imdbID, "tt") {
		imdbID = "tt" + imdbID
	}

	params := url.Values{}
	params.Set("imdb_id", imdbID)
	if len(langs) > 0 {
		params.Set("languages", strings.Join(langs, ","))
	}

	reqURL := subdlAPI + "?" + params.Encode()

	req, err := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "TorrentStreamer/1.0")

	client := &http.Client{Timeout: defaultHTTPTimout}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("subdl request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("subdl returned status %d", resp.StatusCode)
	}

	var result struct {
		Status    bool   `json:"status"`
		Results   int    `json:"results"`
		Subtitles []struct {
			SubID       int    `json:"sd_id"`
			ReleaseName string `json:"release_name"`
			Name        string `json:"name"`
			Lang        string `json:"lang"`
			Author      string `json:"author"`
			URL         string `json:"url"`
		} `json:"subtitles"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode subdl response: %w", err)
	}

	var subs []SubResult
	seen := make(map[string]bool) // dedupe by lang
	for _, s := range result.Subtitles {
		lang := normalizeLang(s.Lang)
		if seen[lang] {
			continue
		}
		seen[lang] = true

		label := s.Name
		if label == "" {
			label = s.ReleaseName
		}

		subs = append(subs, SubResult{
			Source:   "subdl",
			ID:       fmt.Sprintf("%d", s.SubID),
			Lang:     lang,
			Label:    label,
			FileName: s.Name,
		})
	}

	return subs, nil
}

// FetchFromOpenSub searches OpenSubtitles API for subtitles (requires API key)
func FetchFromOpenSub(ctx context.Context, imdbID string, langs []string, apiKey string) ([]SubResult, error) {
	if imdbID == "" || apiKey == "" {
		return nil, nil
	}

	// Normalize IMDB ID - OpenSub wants numeric only
	imdbNumeric := strings.TrimPrefix(imdbID, "tt")

	params := url.Values{}
	params.Set("imdb_id", imdbNumeric)
	if len(langs) > 0 {
		params.Set("languages", strings.Join(langs, ","))
	}
	params.Set("order_by", "download_count")
	params.Set("order_direction", "desc")

	reqURL := openSubAPI + "/subtitles?" + params.Encode()

	req, err := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Api-Key", apiKey)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "TorrentStreamer/1.0")

	client := &http.Client{Timeout: defaultHTTPTimout}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("opensub request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("opensub returned status %d", resp.StatusCode)
	}

	var result struct {
		Data []struct {
			Attributes struct {
				Files []struct {
					FileID   int    `json:"file_id"`
					FileName string `json:"file_name"`
				} `json:"files"`
				Language       string `json:"language"`
				Release        string `json:"release"`
				DownloadCount  int    `json:"download_count"`
				HearingImpaired bool  `json:"hearing_impaired"`
			} `json:"attributes"`
		} `json:"data"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode opensub response: %w", err)
	}

	var subs []SubResult
	seen := make(map[string]bool) // dedupe by lang
	for _, item := range result.Data {
		a := item.Attributes
		if len(a.Files) == 0 {
			continue
		}

		lang := normalizeLang(a.Language)
		if seen[lang] {
			continue
		}
		seen[lang] = true

		fileID := a.Files[0].FileID
		fileName := a.Files[0].FileName
		if fileName == "" {
			fileName = a.Release
		}

		hi := ""
		if a.HearingImpaired {
			hi = " (HI)"
		}

		subs = append(subs, SubResult{
			Source:   "opensub",
			ID:       fmt.Sprintf("%d", fileID),
			Lang:     lang,
			Label:    fmt.Sprintf("%s%s", langName(lang), hi),
			FileName: fileName,
		})
	}

	return subs, nil
}

// DownloadSubdlSubtitle downloads a subtitle from Subdl and returns VTT content
func DownloadSubdlSubtitle(ctx context.Context, subID string) (string, error) {
	cacheKey := "subdl:" + subID

	// Check cache
	subCacheMu.RLock()
	if c, ok := subCache[cacheKey]; ok && time.Since(c.fetched) < cacheTTL {
		subCacheMu.RUnlock()
		return c.vtt, nil
	}
	subCacheMu.RUnlock()

	// Subdl download endpoint
	downloadURL := fmt.Sprintf("https://dl.subdl.com/subtitle/%s", subID)

	req, err := http.NewRequestWithContext(ctx, "GET", downloadURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "TorrentStreamer/1.0")

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("subdl download failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("subdl download returned status %d", resp.StatusCode)
	}

	// Read the content (could be SRT or VTT or ZIP)
	data, err := io.ReadAll(io.LimitReader(resp.Body, 5<<20)) // 5MB limit
	if err != nil {
		return "", fmt.Errorf("failed to read subdl response: %w", err)
	}

	content := string(data)

	// If it's a ZIP file, we'd need to extract it (simplified: just check for SRT/VTT)
	// For now, assume it's SRT and convert if needed
	var vtt string
	if strings.HasPrefix(strings.TrimSpace(content), "WEBVTT") {
		vtt = content
	} else {
		vtt = SRTtoVTT(content)
	}

	// Cache the result
	subCacheMu.Lock()
	subCache[cacheKey] = cachedSub{vtt: vtt, fetched: time.Now()}
	subCacheMu.Unlock()

	return vtt, nil
}

// DownloadOpenSubSubtitle downloads a subtitle from OpenSubtitles and returns VTT content
func DownloadOpenSubSubtitle(ctx context.Context, fileID string, apiKey string) (string, error) {
	if apiKey == "" {
		return "", fmt.Errorf("OpenSubtitles API key required")
	}

	cacheKey := "opensub:" + fileID

	// Check cache
	subCacheMu.RLock()
	if c, ok := subCache[cacheKey]; ok && time.Since(c.fetched) < cacheTTL {
		subCacheMu.RUnlock()
		return c.vtt, nil
	}
	subCacheMu.RUnlock()

	// First, get download link from OpenSubtitles
	downloadReqURL := openSubAPI + "/download"
	reqBody := strings.NewReader(fmt.Sprintf(`{"file_id":%s}`, fileID))

	req, err := http.NewRequestWithContext(ctx, "POST", downloadReqURL, reqBody)
	if err != nil {
		return "", err
	}
	req.Header.Set("Api-Key", apiKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("opensub download request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return "", fmt.Errorf("opensub download returned status %d: %s", resp.StatusCode, string(body))
	}

	var dlResp struct {
		Link string `json:"link"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&dlResp); err != nil {
		return "", fmt.Errorf("failed to decode opensub download response: %w", err)
	}

	if dlResp.Link == "" {
		return "", fmt.Errorf("no download link in opensub response")
	}

	// Now download the actual subtitle file
	subReq, err := http.NewRequestWithContext(ctx, "GET", dlResp.Link, nil)
	if err != nil {
		return "", err
	}

	subResp, err := client.Do(subReq)
	if err != nil {
		return "", fmt.Errorf("failed to download subtitle file: %w", err)
	}
	defer subResp.Body.Close()

	data, err := io.ReadAll(io.LimitReader(subResp.Body, 5<<20))
	if err != nil {
		return "", fmt.Errorf("failed to read subtitle file: %w", err)
	}

	content := string(data)
	var vtt string
	if strings.HasPrefix(strings.TrimSpace(content), "WEBVTT") {
		vtt = content
	} else {
		vtt = SRTtoVTT(content)
	}

	// Cache the result
	subCacheMu.Lock()
	subCache[cacheKey] = cachedSub{vtt: vtt, fetched: time.Now()}
	subCacheMu.Unlock()

	return vtt, nil
}

// ClearCache removes expired entries from the subtitle cache
func ClearCache() {
	subCacheMu.Lock()
	defer subCacheMu.Unlock()

	now := time.Now()
	for k, v := range subCache {
		if now.Sub(v.fetched) > cacheTTL {
			delete(subCache, k)
		}
	}
}

// normalizeLang converts various language codes to ISO 639-1 (2-letter)
func normalizeLang(lang string) string {
	lang = strings.ToLower(strings.TrimSpace(lang))

	// Map of 3-letter to 2-letter codes
	langMap := map[string]string{
		"eng": "en", "english": "en",
		"hin": "hi", "hindi": "hi",
		"spa": "es", "spanish": "es",
		"fra": "fr", "french": "fr",
		"deu": "de", "german": "de",
		"ita": "it", "italian": "it",
		"por": "pt", "portuguese": "pt",
		"rus": "ru", "russian": "ru",
		"jpn": "ja", "japanese": "ja",
		"kor": "ko", "korean": "ko",
		"chi": "zh", "zho": "zh", "chinese": "zh",
		"ara": "ar", "arabic": "ar",
		"nld": "nl", "dutch": "nl",
		"pol": "pl", "polish": "pl",
		"tur": "tr", "turkish": "tr",
		"vie": "vi", "vietnamese": "vi",
		"tha": "th", "thai": "th",
		"ind": "id", "indonesian": "id",
		"msa": "ms", "malay": "ms",
	}

	if mapped, ok := langMap[lang]; ok {
		return mapped
	}

	// If it's already 2 letters, return as-is
	if len(lang) == 2 {
		return lang
	}

	return lang
}

// langName returns a human-readable name for a language code
func langName(code string) string {
	names := map[string]string{
		"en": "English",
		"hi": "Hindi",
		"es": "Spanish",
		"fr": "French",
		"de": "German",
		"it": "Italian",
		"pt": "Portuguese",
		"ru": "Russian",
		"ja": "Japanese",
		"ko": "Korean",
		"zh": "Chinese",
		"ar": "Arabic",
		"nl": "Dutch",
		"pl": "Polish",
		"tr": "Turkish",
		"vi": "Vietnamese",
		"th": "Thai",
		"id": "Indonesian",
		"ms": "Malay",
	}

	if name, ok := names[code]; ok {
		return name
	}
	return strings.ToUpper(code)
}

