package httpapi

import (
	"context"
	"path/filepath"
	"strings"

	"torrent-streamer/internal/downloads"
	"torrent-streamer/internal/subtitles"
)

// DownloadSubtitleSource adapts the OpenSubtitles provider (the same
// credential and search the player's /subtitles/list uses) to the offline
// download preparation pipeline. It is the fallback for requested languages
// the torrent does not carry.
type DownloadSubtitleSource struct{}

// candidatesConsidered bounds release matching to the provider's best-ranked
// results; the provider ordering (hash match, trusted, non-HI, popularity)
// still breaks ties.
const candidatesConsidered = 10

func (DownloadSubtitleSource) FetchSubtitle(ctx context.Context, q downloads.SubtitleQuery) ([]byte, string, error) {
	apiKey := openSubtitlesAPIKey()
	if apiKey == "" {
		return nil, "", downloads.ErrSubtitleNotFound
	}
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
	results, err := subtitles.FetchFromOpenSub(ctx, query, apiKey)
	if err != nil {
		return nil, "", err
	}
	best, ok := bestSubtitleRelease(results, q.Lang, q.VideoName)
	if !ok {
		return nil, "", downloads.ErrSubtitleNotFound
	}
	vtt, err := subtitles.DownloadOpenSubSubtitle(ctx, best.ID, apiKey)
	if err != nil {
		return nil, "", err
	}
	if strings.TrimSpace(vtt) == "" {
		return nil, "", downloads.ErrSubtitleNotFound
	}
	return []byte(vtt), "vtt", nil
}

// bestSubtitleRelease picks the result whose release name shares the most
// tokens with the video file (same group/source/resolution keeps timing in
// sync). Equal scores keep the provider's ranking.
func bestSubtitleRelease(results []subtitles.SubResult, lang, videoName string) (subtitles.SubResult, bool) {
	videoTokens := releaseTokens(videoName)
	var best subtitles.SubResult
	bestScore, considered, found := -1, 0, false
	for _, result := range results {
		if !strings.EqualFold(result.Lang, lang) || result.ID == "" {
			continue
		}
		considered++
		if considered > candidatesConsidered {
			break
		}
		score := 0
		for token := range releaseTokens(result.Release + " " + result.FileName) {
			if videoTokens[token] {
				score++
			}
		}
		if score > bestScore {
			best, bestScore, found = result, score, true
		}
	}
	return best, found
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
