package subtitles

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
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
)

// SubResult represents a subtitle search result from external sources
type SubResult struct {
	Source           string `json:"source"`   // "opensub"
	ID               string `json:"id"`       // unique identifier for download
	Lang             string `json:"lang"`     // ISO 639-1 language code
	Label            string `json:"label"`    // display label
	URL              string `json:"url"`      // download URL (internal endpoint)
	FileName         string `json:"fileName"` // original filename
	Release          string `json:"release,omitempty"`
	DownloadCount    int    `json:"downloadCount,omitempty"`
	HearingImpaired  bool   `json:"hearingImpaired,omitempty"`
	Trusted          bool   `json:"trusted,omitempty"`
	MovieHashMatched bool   `json:"movieHashMatched,omitempty"`
}

// SearchQuery contains provider-neutral identifiers for one playback item.
// Series IDs are used as parent IDs when season/episode are present.
type SearchQuery struct {
	IMDBID  string
	TMDBID  string
	Title   string
	Year    int
	Season  int
	Episode int
	Langs   []string
}

// Cache for downloaded subtitles (VTT content)
var (
	subCache   = make(map[string]cachedSub)
	subCacheMu sync.RWMutex

	searchCache   = make(map[string]cachedSearch)
	searchCacheMu sync.RWMutex

	// OpenSubtitles download quotas are personal-account resources. Serialize
	// download generation so rapid UI clicks cannot spend the same quota twice.
	downloadMu sync.Mutex

	// Keep API calls below the observed free-account burst limit. Static file
	// downloads use a separate CDN limit and do not pass through this limiter.
	openSubRateMu       sync.Mutex
	openSubNext         time.Time
	openSubBlockedUntil time.Time

	openSubTransport = newOpenSubTransport()
)

type cachedSub struct {
	vtt     string
	fetched time.Time
}

type cachedSearch struct {
	results []SubResult
	fetched time.Time
}

func loadDiskSubtitle(fileID int) (string, bool) {
	root := strings.TrimSpace(os.Getenv("SUB_CACHE_DIR"))
	if root == "" || fileID <= 0 {
		return "", false
	}
	path := filepath.Join(root, fmt.Sprintf("opensub-%d.vtt", fileID))
	info, err := os.Stat(path)
	if err != nil || info.IsDir() || info.Size() <= 0 || info.Size() > 5<<20 || time.Since(info.ModTime()) >= cacheTTL {
		return "", false
	}
	data, err := os.ReadFile(path)
	if err != nil || !strings.HasPrefix(strings.TrimSpace(string(data)), "WEBVTT") {
		return "", false
	}
	return string(data), true
}

func saveDiskSubtitle(fileID int, vtt string) error {
	root := strings.TrimSpace(os.Getenv("SUB_CACHE_DIR"))
	if root == "" || fileID <= 0 || vtt == "" {
		return nil
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(root, ".opensub-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err = tmp.WriteString(vtt); err != nil {
		_ = tmp.Close()
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	dst := filepath.Join(root, fmt.Sprintf("opensub-%d.vtt", fileID))
	if err = os.Rename(tmpName, dst); err == nil {
		return nil
	}
	if removeErr := os.Remove(dst); removeErr != nil && !os.IsNotExist(removeErr) {
		return err
	}
	return os.Rename(tmpName, dst)
}

func newOpenSubTransport() *http.Transport {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	dialer := &net.Dialer{
		Timeout:       10 * time.Second,
		KeepAlive:     30 * time.Second,
		FallbackDelay: 200 * time.Millisecond,
	}
	// Keep the hostname intact and let net.Dialer use Happy Eyeballs. Forcing
	// OpenSubtitles through IPv4 made intermittent ISP-to-Cloudflare resets fatal
	// even when the same machine had a healthy IPv6 route.
	transport.DialContext = dialer.DialContext
	return transport
}

func newOpenSubClient(timeout time.Duration) *http.Client {
	return &http.Client{Transport: openSubTransport, Timeout: timeout}
}

func setOpenSubAPIHeaders(req *http.Request, apiKey string) {
	req.Header.Set("Api-Key", apiKey)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "TorWatch v1.2")
	token := strings.TrimSpace(os.Getenv("OPENSUBTITLES_USER_TOKEN"))
	if token == "" {
		token = strings.TrimSpace(os.Getenv("OPENSUB_USER_TOKEN"))
	}
	if token != "" {
		token = strings.TrimSpace(strings.TrimPrefix(token, "Bearer "))
		req.Header.Set("Authorization", "Bearer "+token)
	}
}

const (
	cacheTTL           = 24 * time.Hour
	searchCacheTTL     = 30 * time.Minute
	openSubMinSpacing  = 300 * time.Millisecond
	openSubAPI         = "https://api.opensubtitles.com/api/v1"
	defaultHTTPTimout  = 15 * time.Second
	openSubMaxAttempts = 3
)

// RateLimitError lets the HTTP layer preserve OpenSubtitles' retry guidance
// instead of turning quota throttling into an opaque 500 response.
type RateLimitError struct {
	RetryAfter time.Duration
}

func (e *RateLimitError) Error() string {
	return fmt.Sprintf("OpenSubtitles rate limit reached; retry after %s", e.RetryAfter.Round(time.Second))
}

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

func cloneSubResults(in []SubResult) []SubResult {
	if len(in) == 0 {
		return []SubResult{}
	}
	out := make([]SubResult, len(in))
	copy(out, in)
	return out
}

func waitForOpenSubSlot(ctx context.Context) error {
	openSubRateMu.Lock()
	now := time.Now()
	start := now
	if openSubNext.After(start) {
		start = openSubNext
	}
	if openSubBlockedUntil.After(start) {
		start = openSubBlockedUntil
	}
	openSubNext = start.Add(openSubMinSpacing)
	wait := time.Until(start)
	openSubRateMu.Unlock()

	if wait <= 0 {
		return nil
	}
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func blockOpenSubFor(delay time.Duration) {
	if delay <= 0 {
		return
	}
	openSubRateMu.Lock()
	until := time.Now().Add(delay)
	if until.After(openSubBlockedUntil) {
		openSubBlockedUntil = until
	}
	openSubRateMu.Unlock()
}

func retryAfter(resp *http.Response) time.Duration {
	value := strings.TrimSpace(resp.Header.Get("Retry-After"))
	if seconds, err := strconv.Atoi(value); err == nil && seconds > 0 {
		return time.Duration(seconds) * time.Second
	}
	if when, err := http.ParseTime(value); err == nil {
		if delay := time.Until(when); delay > 0 {
			return delay
		}
	}
	return time.Second
}

func doOpenSubRequest(ctx context.Context, client *http.Client, req *http.Request) (*http.Response, error) {
	for attempt := 0; attempt < openSubMaxAttempts; attempt++ {
		if err := waitForOpenSubSlot(ctx); err != nil {
			return nil, err
		}
		if attempt > 0 && req.GetBody != nil {
			body, err := req.GetBody()
			if err != nil {
				return nil, err
			}
			req.Body = body
		}
		resp, err := client.Do(req)
		if err != nil {
			openSubTransport.CloseIdleConnections()
			if attempt+1 < openSubMaxAttempts {
				if err := waitContext(ctx, time.Duration(attempt+1)*250*time.Millisecond); err != nil {
					return nil, err
				}
				continue
			}
			return nil, err
		}
		if resp.StatusCode != http.StatusTooManyRequests {
			return resp, nil
		}

		delay := retryAfter(resp)
		blockOpenSubFor(delay)
		if attempt+1 == openSubMaxAttempts {
			return resp, nil
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		_ = resp.Body.Close()
		if err := waitContext(ctx, delay); err != nil {
			return nil, err
		}
	}
	return nil, fmt.Errorf("opensub request failed")
}

func waitContext(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		return nil
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func downloadSubtitleResponse(ctx context.Context, client *http.Client, req *http.Request) (*http.Response, error) {
	for attempt := 0; attempt < openSubMaxAttempts; attempt++ {
		attemptReq := req.Clone(ctx)
		resp, err := client.Do(attemptReq)
		if err == nil && resp.StatusCode == http.StatusOK {
			return resp, nil
		}

		delay := time.Duration(attempt+1) * 300 * time.Millisecond
		if resp != nil {
			if resp.StatusCode == http.StatusTooManyRequests {
				delay = retryAfter(resp)
				blockOpenSubFor(delay)
			} else if resp.StatusCode < 500 {
				return resp, nil
			}
			if attempt+1 == openSubMaxAttempts {
				return resp, nil
			}
			_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
			_ = resp.Body.Close()
		}
		openSubTransport.CloseIdleConnections()
		if attempt+1 < openSubMaxAttempts {
			if waitErr := waitContext(ctx, delay); waitErr != nil {
				return nil, waitErr
			}
			continue
		}
		if err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("subtitle download failed after retries")
	}
	return nil, fmt.Errorf("subtitle download failed")
}

// FetchFromOpenSub searches OpenSubtitles using stable title identifiers when
// available. For episodic content OpenSubtitles expects the show's identifier
// as a parent ID together with season and episode numbers.
func FetchFromOpenSub(ctx context.Context, query SearchQuery, apiKey string) ([]SubResult, error) {
	if apiKey == "" {
		return nil, nil
	}

	params := url.Values{}
	imdbNumeric := strings.TrimLeft(strings.TrimPrefix(strings.TrimSpace(query.IMDBID), "tt"), "0")
	tmdbNumeric := strings.TrimLeft(strings.TrimSpace(query.TMDBID), "0")
	isEpisode := query.Season > 0 && query.Episode > 0

	if isEpisode {
		if imdbNumeric != "" {
			params.Set("parent_imdb_id", imdbNumeric)
		} else if tmdbNumeric != "" {
			params.Set("parent_tmdb_id", tmdbNumeric)
		} else if strings.TrimSpace(query.Title) != "" {
			params.Set("query", strings.TrimSpace(query.Title))
		}
		params.Set("season_number", strconv.Itoa(query.Season))
		params.Set("episode_number", strconv.Itoa(query.Episode))
		params.Set("type", "episode")
	} else {
		if imdbNumeric != "" {
			params.Set("imdb_id", imdbNumeric)
		} else if tmdbNumeric != "" {
			params.Set("tmdb_id", tmdbNumeric)
		} else if strings.TrimSpace(query.Title) != "" {
			params.Set("query", strings.TrimSpace(query.Title))
		}
		params.Set("type", "movie")
		if query.Year > 0 {
			params.Set("year", strconv.Itoa(query.Year))
		}
	}

	if params.Get("imdb_id") == "" && params.Get("parent_imdb_id") == "" && params.Get("tmdb_id") == "" && params.Get("parent_tmdb_id") == "" && params.Get("query") == "" {
		return nil, nil
	}

	if len(query.Langs) > 0 {
		params.Set("languages", strings.Join(query.Langs, ","))
	}
	params.Set("order_by", "download_count")
	params.Set("order_direction", "desc")
	cacheKey := params.Encode()
	searchCacheMu.RLock()
	if cached, ok := searchCache[cacheKey]; ok && time.Since(cached.fetched) < searchCacheTTL {
		searchCacheMu.RUnlock()
		return cloneSubResults(cached.results), nil
	}
	searchCacheMu.RUnlock()

	reqURL := openSubAPI + "/subtitles?" + cacheKey

	req, err := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
	if err != nil {
		return nil, err
	}
	setOpenSubAPIHeaders(req, apiKey)

	client := newOpenSubClient(defaultHTTPTimout)
	resp, err := doOpenSubRequest(ctx, client, req)
	if err != nil {
		return nil, fmt.Errorf("opensub request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		if resp.StatusCode == http.StatusTooManyRequests {
			return nil, &RateLimitError{RetryAfter: retryAfter(resp)}
		}
		return nil, fmt.Errorf("opensub returned status %d", resp.StatusCode)
	}

	var result struct {
		Data []struct {
			Attributes struct {
				Files []struct {
					FileID   int    `json:"file_id"`
					FileName string `json:"file_name"`
				} `json:"files"`
				Language        string `json:"language"`
				Release         string `json:"release"`
				DownloadCount   int    `json:"download_count"`
				HearingImpaired bool   `json:"hearing_impaired"`
				Trusted         bool   `json:"from_trusted"`
				MovieHashMatch  bool   `json:"moviehash_match"`
			} `json:"attributes"`
		} `json:"data"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode opensub response: %w", err)
	}

	var subs []SubResult
	seen := make(map[int]bool)
	wanted := make(map[string]bool, len(query.Langs))
	for _, lang := range query.Langs {
		if normalized := normalizeLang(lang); normalized != "" {
			wanted[normalized] = true
		}
	}
	for _, item := range result.Data {
		a := item.Attributes
		if len(a.Files) == 0 {
			continue
		}

		lang := normalizeLang(a.Language)
		if lang == "" || (len(wanted) > 0 && !wanted[lang]) {
			continue
		}

		fileID := a.Files[0].FileID
		if fileID <= 0 || seen[fileID] {
			continue
		}
		seen[fileID] = true
		fileName := a.Files[0].FileName
		if fileName == "" {
			fileName = a.Release
		}

		hi := ""
		if a.HearingImpaired {
			hi = " (HI)"
		}

		subs = append(subs, SubResult{
			Source:           "opensub",
			ID:               fmt.Sprintf("%d", fileID),
			Lang:             lang,
			Label:            fmt.Sprintf("%s%s", langName(lang), hi),
			FileName:         fileName,
			Release:          a.Release,
			DownloadCount:    a.DownloadCount,
			HearingImpaired:  a.HearingImpaired,
			Trusted:          a.Trusted,
			MovieHashMatched: a.MovieHashMatch,
		})
		if len(subs) >= 50 {
			break
		}
	}
	sort.SliceStable(subs, func(i, j int) bool {
		if subs[i].MovieHashMatched != subs[j].MovieHashMatched {
			return subs[i].MovieHashMatched
		}
		if subs[i].Trusted != subs[j].Trusted {
			return subs[i].Trusted
		}
		if subs[i].HearingImpaired != subs[j].HearingImpaired {
			return !subs[i].HearingImpaired
		}
		return subs[i].DownloadCount > subs[j].DownloadCount
	})

	searchCacheMu.Lock()
	searchCache[cacheKey] = cachedSearch{results: cloneSubResults(subs), fetched: time.Now()}
	searchCacheMu.Unlock()

	return subs, nil
}

// DownloadOpenSubSubtitle downloads a subtitle from OpenSubtitles and returns VTT content
func DownloadOpenSubSubtitle(ctx context.Context, fileID string, apiKey string) (string, error) {
	if apiKey == "" {
		return "", fmt.Errorf("OpenSubtitles API key required")
	}
	parsedFileID, err := strconv.Atoi(fileID)
	if err != nil || parsedFileID <= 0 {
		return "", fmt.Errorf("invalid OpenSubtitles file ID")
	}

	cacheKey := "opensub:" + strconv.Itoa(parsedFileID)

	// Check cache
	subCacheMu.RLock()
	if c, ok := subCache[cacheKey]; ok && time.Since(c.fetched) < cacheTTL {
		subCacheMu.RUnlock()
		return c.vtt, nil
	}
	subCacheMu.RUnlock()
	if cached, ok := loadDiskSubtitle(parsedFileID); ok {
		subCacheMu.Lock()
		subCache[cacheKey] = cachedSub{vtt: cached, fetched: time.Now()}
		subCacheMu.Unlock()
		return cached, nil
	}

	downloadMu.Lock()
	defer downloadMu.Unlock()
	// Another request may have populated the cache while this one waited.
	subCacheMu.RLock()
	if c, ok := subCache[cacheKey]; ok && time.Since(c.fetched) < cacheTTL {
		subCacheMu.RUnlock()
		return c.vtt, nil
	}
	subCacheMu.RUnlock()
	if cached, ok := loadDiskSubtitle(parsedFileID); ok {
		subCacheMu.Lock()
		subCache[cacheKey] = cachedSub{vtt: cached, fetched: time.Now()}
		subCacheMu.Unlock()
		return cached, nil
	}

	// First, get download link from OpenSubtitles
	downloadReqURL := openSubAPI + "/download"
	reqBody := strings.NewReader(fmt.Sprintf(`{"file_id":%d}`, parsedFileID))

	req, err := http.NewRequestWithContext(ctx, "POST", downloadReqURL, reqBody)
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	setOpenSubAPIHeaders(req, apiKey)

	client := newOpenSubClient(30 * time.Second)
	resp, err := doOpenSubRequest(ctx, client, req)
	if err != nil {
		return "", fmt.Errorf("opensub download request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		if resp.StatusCode == http.StatusTooManyRequests {
			return "", &RateLimitError{RetryAfter: retryAfter(resp)}
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return "", fmt.Errorf("opensub download returned status %d: %s", resp.StatusCode, string(body))
	}

	var dlResp struct {
		Link      string `json:"link"`
		Remaining int    `json:"remaining"`
		Requests  int    `json:"requests"`
		Message   string `json:"message"`
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
	subReq.Header.Set("User-Agent", "TorWatch v1.2")
	subReq.Header.Set("Accept", "text/plain, application/x-subrip, text/vtt, */*")
	subReq.Header.Set("Api-Key", apiKey)

	subResp, err := downloadSubtitleResponse(ctx, client, subReq)
	if err != nil {
		return "", fmt.Errorf("failed to download subtitle file: %w", err)
	}
	defer subResp.Body.Close()
	if subResp.StatusCode != http.StatusOK {
		if subResp.StatusCode == http.StatusTooManyRequests {
			return "", &RateLimitError{RetryAfter: retryAfter(subResp)}
		}
		return "", fmt.Errorf("subtitle file returned status %d", subResp.StatusCode)
	}

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
	if err := saveDiskSubtitle(parsedFileID, vtt); err != nil {
		log.Printf("[subtitles] persistent cache write failed for %d: %v", parsedFileID, err)
	}

	return vtt, nil
}

// ClearCache removes expired entries from the subtitle cache
func ClearCache() {
	subCacheMu.Lock()
	now := time.Now()
	for k, v := range subCache {
		if now.Sub(v.fetched) > cacheTTL {
			delete(subCache, k)
		}
	}
	subCacheMu.Unlock()

	searchCacheMu.Lock()
	for k, v := range searchCache {
		if now.Sub(v.fetched) > searchCacheTTL {
			delete(searchCache, k)
		}
	}
	searchCacheMu.Unlock()
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
