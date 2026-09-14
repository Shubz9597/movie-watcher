// Package skipsegments resolves intro/recap/credits timestamps for the
// mobile player (skip-intro support where timestamps exist). It is the Go
// port of the desktop Electron helper (electron/playback/skip-segments.js):
// AniSkip for anime, TheIntroDB for TV, normalized to the actual file
// duration and cached for 24 h.
//
// The endpoint lives on the server (not the client) because both provider
// APIs are third-party origins with unknown CORS posture, and the response
// cache should be shared per household, not per device.
//
// GET /skip-segments?kind=tv|anime&tmdbId=&imdbId=&malId=&season=&episode=
//
//	&absoluteEpisode=&durationSeconds=
package skipsegments

import (
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"torrent-streamer/internal/middleware"
)

const (
	aniskipBaseURL   = "https://api.aniskip.com/v2/skip-times"
	theintrodbBase   = "https://api.theintrodb.org/v3/media"
	requestTimeout   = 3500 * time.Millisecond
	cacheTTL         = 24 * time.Hour
	cacheMaxEntries  = 250
	minSegmentSecs   = 3
	durationSlackSec = 120
)

// Segment is one normalized, clamped skip window (seconds).
type Segment struct {
	Type     string  `json:"type"` // intro | recap | credits
	Start    float64 `json:"start"`
	End      float64 `json:"end"`
	Provider string  `json:"provider"`
}

var typePriority = map[string]int{"recap": 0, "intro": 1, "credits": 2}

type cacheEntry struct {
	savedAt  time.Time
	segments []Segment
}

var (
	cacheMu sync.Mutex
	cache   = map[string]cacheEntry{}
)

func finite(v interface{}) float64 {
	switch n := v.(type) {
	case float64:
		if !isNaN(n) {
			return n
		}
	case int:
		return float64(n)
	case string:
		if f, err := strconv.ParseFloat(strings.TrimSpace(n), 64); err == nil && !isNaN(f) {
			return f
		}
	}
	return math.NaN()
}

func isNaN(f float64) bool { return f != f }

func normalizeSegment(kind string, start, end, duration float64, provider string) *Segment {
	if isNaN(start) {
		return nil
	}
	if isNaN(end) && duration > 0 {
		end = duration
	}
	if isNaN(end) || end <= start {
		return nil
	}
	if start < 0 {
		start = 0
	}
	if duration > 0 && end > duration {
		end = duration
	}
	if end-start < minSegmentSecs {
		return nil
	}
	return &Segment{Type: kind, Start: start, End: end, Provider: provider}
}

func dedupeAndSort(segments []Segment) []Segment {
	seen := map[string]bool{}
	out := make([]Segment, 0, len(segments))
	for _, s := range segments {
		key := s.Type + ":" + strconv.Itoa(int(math.Round(s.Start*4))) + ":" + strconv.Itoa(int(math.Round(s.End*4)))
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, s)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Start != out[j].Start {
			return out[i].Start < out[j].Start
		}
		if typePriority[out[i].Type] != typePriority[out[j].Type] {
			return typePriority[out[i].Type] < typePriority[out[j].Type]
		}
		return out[i].End < out[j].End
	})
	if out == nil {
		out = []Segment{}
	}
	return out
}

func fetchJSON(ctx context.Context, requestURL string) (map[string]interface{}, error) {
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, errStatus(resp.StatusCode)
	}
	var payload map[string]interface{}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&payload); err != nil {
		return nil, err
	}
	return payload, nil
}

type statusError int

func (e statusError) Error() string { return "skip segment request returned " + strconv.Itoa(int(e)) }
func errStatus(code int) error      { return statusError(code) }

func asArray(v interface{}) []interface{} {
	if list, ok := v.([]interface{}); ok {
		return list
	}
	return nil
}

func asObject(v interface{}) map[string]interface{} {
	if obj, ok := v.(map[string]interface{}); ok {
		return obj
	}
	return nil
}

func normalizeAniSkip(payload map[string]interface{}, duration float64) []Segment {
	if payload == nil || payload["found"] != true {
		return nil
	}
	typeMap := map[string]string{
		"op":       "intro",
		"mixed-op": "intro",
		"recap":    "recap",
		"ed":       "credits",
		"mixed-ed": "credits",
	}
	var segments []Segment
	for _, raw := range asArray(payload["results"]) {
		result := asObject(raw)
		if result == nil {
			continue
		}
		kind, ok := typeMap[strings.ToLower(stringValue(result["skipType"]))]
		if !ok {
			continue
		}
		sourceDuration := finite(result["episodeLength"])
		offset := 0.0
		// AniSkip timestamps are relative to the submitted episode runtime.
		// Small differences usually come from alternate releases with a
		// longer/shorter pre-roll; large ones mean a mismatched file.
		if !isNaN(sourceDuration) && duration > 0 && math.Abs(duration-sourceDuration) <= durationSlackSec {
			offset = duration - sourceDuration
		}
		interval := asObject(result["interval"])
		if interval == nil {
			continue
		}
		start := finite(interval["startTime"])
		end := finite(interval["endTime"])
		if isNaN(start) || isNaN(end) {
			continue
		}
		if seg := normalizeSegment(kind, start+offset, end+offset, duration, "aniskip"); seg != nil {
			segments = append(segments, *seg)
		}
	}
	return segments
}

func stringValue(v interface{}) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

var playbackSkipSegments = [][2]string{{"recap", "recap"}, {"intro", "intro"}, {"credits", "credits"}}

func normalizeTheIntroDB(payload map[string]interface{}, duration float64) []Segment {
	if payload == nil {
		return nil
	}
	var segments []Segment
	for _, pair := range playbackSkipSegments {
		for _, raw := range asArray(payload[pair[0]]) {
			row := asObject(raw)
			if row == nil {
				continue
			}
			startMs := finite(row["start_ms"])
			if isNaN(startMs) {
				continue
			}
			endMs := finite(row["end_ms"])
			end := math.NaN() // missing end = open-ended (duration clamp applies)
			if !isNaN(endMs) {
				end = endMs / 1000
			}
			if seg := normalizeSegment(pair[1], startMs/1000, end, duration, "theintrodb"); seg != nil {
				segments = append(segments, *seg)
			}
		}
	}
	return segments
}

func cacheKey(kind string, context url.Values, duration float64, season, episode int) string {
	switch kind {
	case "anime":
		return "aniskip:" + context.Get("malId") + ":" + strconv.Itoa(episode) + ":" + strconv.Itoa(int(math.Round(duration)))
	default:
		id := context.Get("tmdbId")
		if id == "" {
			id = context.Get("imdbId")
		}
		return "theintrodb:" + id + ":" + strconv.Itoa(season) + ":" + strconv.Itoa(episode) + ":" + strconv.Itoa(int(math.Round(duration)))
	}
}

func readCache(key string) []Segment {
	cacheMu.Lock()
	defer cacheMu.Unlock()
	entry, ok := cache[key]
	if !ok || time.Since(entry.savedAt) > cacheTTL {
		delete(cache, key)
		return nil
	}
	return entry.segments
}

func writeCache(key string, segments []Segment) {
	cacheMu.Lock()
	defer cacheMu.Unlock()
	cache[key] = cacheEntry{savedAt: time.Now(), segments: segments}
	if len(cache) <= cacheMaxEntries {
		return
	}
	// Bounded memory: drop the oldest entry (insertion order via scan).
	var oldestKey string
	var oldest time.Time
	for k, v := range cache {
		if oldestKey == "" || v.savedAt.Before(oldest) {
			oldestKey, oldest = k, v.savedAt
		}
	}
	delete(cache, oldestKey)
}

// Handler serves GET /skip-segments.
func Handler(w http.ResponseWriter, r *http.Request) {
	middleware.EnableCORS(w)
	if r.Method == http.MethodOptions {
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	q := r.URL.Query()
	kind := strings.ToLower(q.Get("kind"))
	duration := finite(q.Get("durationSeconds"))
	season, _ := strconv.Atoi(q.Get("season"))
	episode, _ := strconv.Atoi(q.Get("episode"))
	if kind == "anime" {
		if abs, err := strconv.Atoi(q.Get("absoluteEpisode")); err == nil && abs > 0 {
			episode = abs
		}
	}
	if math.IsNaN(duration) || math.IsInf(duration, 0) || duration <= 0 || duration > 7*24*3600 || episode <= 0 {
		writeSegments(w, []Segment{})
		return
	}

	key := cacheKey(kind, q, duration, season, episode)
	if cached := readCache(key); cached != nil {
		writeSegments(w, cached)
		return
	}

	ctx := r.Context()
	var segments []Segment
	switch kind {
	case "anime":
		malID, _ := strconv.Atoi(q.Get("malId"))
		if malID <= 0 {
			writeSegments(w, []Segment{})
			return
		}
		base := aniskipBaseURL + "/" + strconv.Itoa(malID) + "/" + strconv.Itoa(episode)
		length := strconv.Itoa(int(math.Round(duration)))
		payload, err := fetchJSON(ctx, base+"?types=op&types=ed&types=recap&episodeLength="+length)
		if err != nil {
			// AniSkip returns HTTP 500 when no entry closely matches the
			// supplied runtime; retry duration-agnostically (normalization
			// below still clamps and offsets to the real file).
			payload, err = fetchJSON(ctx, base+"?types=op&types=ed&types=recap&episodeLength=0")
		}
		if err == nil {
			segments = normalizeAniSkip(payload, duration)
			missing := map[string]bool{"intro": true, "credits": true}
			for _, s := range segments {
				delete(missing, s.Type)
			}
			if len(missing) > 0 {
				// AniSkip fails when standard and mixed filters are combined;
				// query mixed OP/ED only to fill the gaps.
				if mixed, err := fetchJSON(ctx, base+"?types=mixed-op&types=mixed-ed&episodeLength="+length); err == nil {
					for _, s := range normalizeAniSkip(mixed, duration) {
						if missing[s.Type] {
							segments = append(segments, s)
						}
					}
					segments = dedupeAndSort(segments)
				}
			}
		}
	case "tv":
		tmdbID, _ := strconv.Atoi(q.Get("tmdbId"))
		imdbID := strings.TrimSpace(q.Get("imdbId"))
		if tmdbID <= 0 && !imdbIDPattern.MatchString(imdbID) {
			writeSegments(w, []Segment{})
			return
		}
		if season < 0 {
			season = 0
		}
		params := url.Values{}
		if tmdbID > 0 {
			params.Set("tmdb_id", strconv.Itoa(tmdbID))
		} else {
			params.Set("imdb_id", imdbID)
		}
		params.Set("season", strconv.Itoa(season))
		params.Set("episode", strconv.Itoa(episode))
		params.Set("duration_ms", strconv.Itoa(int(math.Round(duration*1000))))
		if payload, err := fetchJSON(ctx, theintrodbBase+"?"+params.Encode()); err == nil {
			segments = normalizeTheIntroDB(payload, duration)
		}
	default:
		writeSegments(w, []Segment{})
		return
	}

	if segments == nil {
		segments = []Segment{}
	}
	writeCache(key, segments)
	writeSegments(w, segments)
}

var imdbIDPattern = regexp.MustCompile(`^tt\d{7,10}$`)

func writeSegments(w http.ResponseWriter, segments []Segment) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"segments": segments})
}
