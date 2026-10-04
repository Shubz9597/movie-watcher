package httpapi

import (
	"context"
	"errors"
	"log"
	"net/url"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"torrent-streamer/internal/downloads"
	"torrent-streamer/internal/subtitles"
)

// DownloadSubtitleSource adapts the OpenSubtitles provider (the same
// credential and search the player's /subtitles/list uses) to the offline
// download preparation pipeline. It is the fallback for requested languages
// the torrent does not carry.
type DownloadSubtitleSource struct{}

// subtitleRetryDelays spaces retries of transient provider failures
// (timeouts, resets, 5xx, rate limits). The provider is noticeably flaky from
// home networks; one blip should not fail a download that asked for
// subtitles. "No match" is final and is not retried.
var subtitleRetryDelays = []time.Duration{10 * time.Second, 30 * time.Second, 60 * time.Second}

func (s DownloadSubtitleSource) FetchSubtitle(ctx context.Context, q downloads.SubtitleQuery) ([]byte, string, error) {
	for attempt := 0; ; attempt++ {
		data, ext, err := s.fetchOnce(ctx, q)
		if err == nil || errors.Is(err, downloads.ErrSubtitleNotFound) || attempt >= len(subtitleRetryDelays) {
			return data, ext, err
		}
		log.Printf("[downloads] subtitle %q attempt %d failed, retrying: %v", q.Lang, attempt+1, err)
		select {
		case <-ctx.Done():
			return nil, "", ctx.Err()
		case <-time.After(subtitleRetryDelays[attempt]):
		}
	}
}

func (DownloadSubtitleSource) fetchOnce(ctx context.Context, q downloads.SubtitleQuery) ([]byte, string, error) {
	apiKey := openSubtitlesAPIKey()
	query := subtitles.SearchQuery{
		IMDBID: q.Hints.IMDBID,
		Title:  q.Hints.Title,
		Year:   q.Hints.Year,
		Langs:  []string{q.Lang},
	}
	// Canonical ids: tmdb:movie:<id> / tmdb:tv:<id>. Series episodes search
	// by parent id plus season/episode; other namespaces rely on the hints.
	if parts := strings.Split(q.SeriesID, ":"); len(parts) == 3 && parts[0] == "tmdb" {
		query.TMDBID = parts[2]
		if parts[1] == "tv" {
			query.Season, query.Episode = q.Season, q.Episode
		}
	} else if q.Season > 0 || q.Episode > 0 {
		query.Season, query.Episode = q.Season, q.Episode
	}
	// Stremio's keyless OpenSubtitles addon first: it matches episodes by
	// IMDb id and its downloads work where the configured key's download
	// endpoint keeps failing. The key is the fallback (and covers titles
	// without an IMDb id).
	// Anime ids (anilist:<id>) map to the show's IMDb season/episode.
	stremioQuery := query
	if parts := strings.Split(q.SeriesID, ":"); len(parts) == 2 && parts[0] == "anilist" {
		if anilistID, err := strconv.Atoi(parts[1]); err == nil {
			if imdb, season, episode, ok := subtitles.AnimeEpisodeIMDb(ctx, anilistID, 0, q.Episode); ok {
				stremioQuery.IMDBID, stremioQuery.Season, stremioQuery.Episode = imdb, season, episode
			}
		}
	}
	// Both catalogs, best release match first: Stremio's addon lists only a
	// few files per language (sometimes all CAM-era), the key's catalog is
	// complete but its downloads fail often. Try the closest few in order.
	var candidates []subtitles.SubResult
	if results, err := subtitles.FetchFromStremio(ctx, stremioQuery); err == nil {
		candidates = append(candidates, results...)
	}
	if apiKey != "" {
		if results, err := subtitles.FetchFromOpenSub(ctx, query, apiKey); err == nil {
			candidates = append(candidates, results...)
		}
	}
	ranked := rankSubtitleResults(candidates, q.Lang, q.VideoName)
	if len(ranked) == 0 {
		return nil, "", downloads.ErrSubtitleNotFound
	}
	var vtt string
	var err error
	for _, candidate := range ranked[:min(len(ranked), downloadAttempts)] {
		if candidate.Source == "stremio" {
			vtt, err = subtitles.DownloadStremioSubtitle(ctx, candidate.ID)
		} else {
			vtt, err = subtitles.DownloadOpenSubSubtitle(ctx, candidate.ID, apiKey)
		}
		if err == nil && strings.TrimSpace(vtt) != "" {
			return []byte(vtt), "vtt", nil
		}
	}
	if err != nil {
		return nil, "", err
	}
	return nil, "", downloads.ErrSubtitleNotFound
}

// downloadAttempts bounds how many ranked subtitles an offline download
// tries before giving up.
const downloadAttempts = 4

// earlyReleaseTokens mark subtitles timed for CAM/TS-era copies; they drift
// against a proper release of the same title.
var earlyReleaseTokens = map[string]bool{
	"cam": true, "camrip": true, "hdcam": true, "ts": true, "hdts": true, "telesync": true,
	"tc": true, "telecine": true, "scr": true, "dvdscr": true, "screener": true, "workprint": true, "r5": true,
}

// subtitleScore counts release tokens (group, source, resolution...) a
// subtitle shares with the video, minus a penalty for CAM/TS-era timing when
// the video is not such a copy.
func subtitleScore(release, fileName string, videoTokens map[string]bool, videoEarly bool) int {
	score, early := 0, false
	for token := range releaseTokens(release + " " + fileName) {
		if videoTokens[token] {
			score++
		}
		if earlyReleaseTokens[token] {
			early = true
		}
	}
	if early && !videoEarly {
		score -= 5
	}
	return score
}

func hasEarlyRelease(tokens map[string]bool) bool {
	for token := range tokens {
		if earlyReleaseTokens[token] {
			return true
		}
	}
	return false
}

// rankSubtitleResults keeps one language's results, closest release first;
// ties keep catalog order (Stremio's results come first).
func rankSubtitleResults(results []subtitles.SubResult, lang, videoName string) []subtitles.SubResult {
	videoTokens := releaseTokens(videoName)
	videoEarly := hasEarlyRelease(videoTokens)
	ranked := make([]subtitles.SubResult, 0, len(results))
	for _, result := range results {
		if strings.EqualFold(result.Lang, lang) && result.ID != "" {
			ranked = append(ranked, result)
		}
	}
	sort.SliceStable(ranked, func(i, j int) bool {
		return subtitleScore(ranked[i].Release, ranked[i].FileName, videoTokens, videoEarly) >
			subtitleScore(ranked[j].Release, ranked[j].FileName, videoTokens, videoEarly)
	})
	return ranked
}

// sortTracksByRelease orders the player's subtitle tracks the same way.
func sortTracksByRelease(tracks []SubtitleTrack, videoName string) {
	videoTokens := releaseTokens(videoName)
	if len(videoTokens) == 0 {
		return
	}
	videoEarly := hasEarlyRelease(videoTokens)
	sort.SliceStable(tracks, func(i, j int) bool {
		return subtitleScore(tracks[i].Release, tracks[i].FileName, videoTokens, videoEarly) >
			subtitleScore(tracks[j].Release, tracks[j].FileName, videoTokens, videoEarly)
	})
}

// magnetDisplayName returns a magnet's dn (release name), if any.
func magnetDisplayName(magnet string) string {
	parsed, err := url.Parse(strings.TrimSpace(magnet))
	if err != nil || !strings.EqualFold(parsed.Scheme, "magnet") {
		return ""
	}
	return parsed.Query().Get("dn")
}

func releaseTokens(name string) map[string]bool {
	name = strings.TrimSuffix(strings.ToLower(name), strings.ToLower(filepath.Ext(name)))
	tokens := map[string]bool{}
	for _, token := range strings.FieldsFunc(name, func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9')
	}) {
		if len(token) > 1 {
			tokens[token] = true
		}
	}
	return tokens
}
