package subtitles

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Anime catalog entries number episodes per season or arc (AniList, MAL),
// while subtitle databases file them under the whole show's IMDb id with
// TVDB-style seasons: Demon Slayer's Entertainment District arc episode 5 is
// IMDb tt9335498 S03E05. ani.zip publishes exactly that per-episode mapping.

type animeMapping struct {
	imdb     string
	episodes map[int][2]int // entry episode -> {season, episode}
	expires  time.Time
}

var (
	animeMappingsMu sync.Mutex
	animeMappings   = map[string]animeMapping{}
)

// AnimeEpisodeIMDb maps an AniList (or, failing that, MAL) episode to the
// show's IMDb id and IMDb season/episode. ok is false when ani.zip has no
// IMDb mapping. Results, including misses, are cached for a day.
func AnimeEpisodeIMDb(ctx context.Context, anilistID, malID, episode int) (imdb string, season, imdbEpisode int, ok bool) {
	var key, param string
	switch {
	case anilistID > 0:
		key, param = "anilist:"+strconv.Itoa(anilistID), "anilist_id="+strconv.Itoa(anilistID)
	case malID > 0:
		key, param = "mal:"+strconv.Itoa(malID), "mal_id="+strconv.Itoa(malID)
	default:
		return "", 0, 0, false
	}
	animeMappingsMu.Lock()
	mapping, cached := animeMappings[key]
	animeMappingsMu.Unlock()
	if !cached || time.Now().After(mapping.expires) {
		fetched, err := fetchAnimeMapping(ctx, param)
		if err != nil {
			return "", 0, 0, false // transient: retried on the next request
		}
		mapping = fetched
		animeMappingsMu.Lock()
		animeMappings[key] = mapping
		animeMappingsMu.Unlock()
	}
	if mapping.imdb == "" {
		return "", 0, 0, false
	}
	if pair, found := mapping.episodes[episode]; found && pair[0] > 0 && pair[1] > 0 {
		return mapping.imdb, pair[0], pair[1], true
	}
	// No per-episode row (films, unaired): keep the entry's own numbering.
	return mapping.imdb, 1, episode, true
}

func fetchAnimeMapping(ctx context.Context, param string) (animeMapping, error) {
	base := strings.TrimRight(os.Getenv("TORWATCH_ANIZIP_BASE_URL"), "/")
	if base == "" {
		base = "https://api.ani.zip"
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/mappings?"+param, nil)
	if err != nil {
		return animeMapping{}, err
	}
	resp, err := stremioHTTP.Do(req)
	if err != nil {
		return animeMapping{}, err
	}
	defer resp.Body.Close()
	mapping := animeMapping{episodes: map[int][2]int{}, expires: time.Now().Add(24 * time.Hour)}
	if resp.StatusCode == http.StatusNotFound {
		return mapping, nil
	}
	if resp.StatusCode != http.StatusOK {
		return animeMapping{}, fmt.Errorf("ani.zip: status %d", resp.StatusCode)
	}
	var payload struct {
		Mappings struct {
			IMDBID string `json:"imdb_id"`
		} `json:"mappings"`
		Episodes map[string]struct {
			SeasonNumber  int `json:"seasonNumber"`
			EpisodeNumber int `json:"episodeNumber"`
		} `json:"episodes"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&payload); err != nil {
		return animeMapping{}, err
	}
	if strings.HasPrefix(payload.Mappings.IMDBID, "tt") {
		mapping.imdb = payload.Mappings.IMDBID
	}
	for key, episode := range payload.Episodes {
		number, err := strconv.Atoi(key) // "S1"-style specials are skipped
		if err == nil {
			mapping.episodes[number] = [2]int{episode.SeasonNumber, episode.EpisodeNumber}
		}
	}
	return mapping, nil
}
