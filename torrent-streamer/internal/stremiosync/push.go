package stremiosync

import (
	"context"
	"fmt"
	"log"
	"math"
	"strconv"
	"strings"
	"time"
)

// Push: what a profile watches in TorWatch goes to its Stremio library, the
// way Stremio's own apps record playback (stremio-core player.rs), so
// Stremio's Continue Watching on a TV starts at the same episode and
// minute. Stremio keeps the item with the newest _mtime, and an item is in
// Continue Watching while its timeOffset is above 0.
//
// Safety: only playback fields of an item are changed (everything else
// Stremio has is kept); an item Stremio changed after TorWatch's progress is
// left alone; nothing is ever removed.

// TitleInfo is how Stremio names a catalog title.
type TitleInfo struct {
	IMDb   string // tt…
	Name   string
	Kind   string // movie | series
	Poster string
}

// Describer maps a catalog title id to Stremio's naming (catalog.Service).
type Describer interface {
	StremioTitle(ctx context.Context, id string) (TitleInfo, bool)
}

// AnimeEntry is what the anime list knows of an AniList entry.
type AnimeEntry struct {
	Kitsu         int
	IMDb          string
	Season        int
	HasSeason     bool
	EpisodeOffset int
}

// progressRow is a show's latest progress.
type progressRow struct {
	seriesID        string
	season, episode int
	positionS       int
	durationS       int
	percent         float64
	updatedAt       time.Time
}

// pushTarget is where one show's progress goes in Stremio.
type pushTarget struct {
	id      string // library item id: tt… or kitsu:N
	videoID string // tt…:S:E, tt… (film), kitsu:N:E
	name    string
	kind    string
	poster  string
}

// PushProfile writes the account's progress since its last push. It
// returns how many Stremio items it wrote.
func (s *Service) PushProfile(ctx context.Context, account Account) (int, error) {
	since := time.Now().Add(-24 * time.Hour)
	if account.LastPushAt != nil {
		since = *account.LastPushAt
	}
	rows, newest, err := s.recentProgress(ctx, account.ProfileID, since)
	if err != nil || len(rows) == 0 {
		return 0, err
	}
	library, err := s.Client.LibraryRaw(ctx, account.AuthKey)
	if err != nil {
		return 0, err
	}
	byID := make(map[string]map[string]any, len(library))
	for _, item := range library {
		byID[item["_id"].(string)] = item
	}
	now := time.Now().UTC()
	var changes []map[string]any
	for _, row := range rows {
		target, ok := s.targetFor(ctx, row, byID)
		if !ok {
			continue
		}
		if item, ok := updatedItem(byID[target.id], target, row, now); ok {
			changes = append(changes, item)
		}
	}
	if err := s.Client.PutLibrary(ctx, account.AuthKey, changes); err != nil {
		return 0, err
	}
	if err := s.Store.MarkPushed(ctx, account.ProfileID, newest, len(changes)); err != nil {
		return len(changes), err
	}
	if len(changes) > 0 {
		log.Printf("[stremio] profile %s: %d title(s) sent to Stremio", account.ProfileID, len(changes))
	}
	return len(changes), nil
}

func (s *Service) recentProgress(ctx context.Context, profileID string, since time.Time) ([]progressRow, time.Time, error) {
	rows, err := s.Store.DB.QueryContext(ctx, `
SELECT DISTINCT ON (series_id) series_id, season, episode, position_s, duration_s, percent::float8, updated_at
FROM watch_progress
WHERE subject_id=$1 AND updated_at > $2
ORDER BY series_id, updated_at DESC, id DESC`, profileID, since)
	if err != nil {
		return nil, since, err
	}
	defer rows.Close()
	var out []progressRow
	newest := since
	for rows.Next() {
		var row progressRow
		if err := rows.Scan(&row.seriesID, &row.season, &row.episode, &row.positionS, &row.durationS, &row.percent, &row.updatedAt); err != nil {
			return nil, since, err
		}
		out = append(out, row)
		if row.updatedAt.After(newest) {
			newest = row.updatedAt
		}
	}
	return out, newest, rows.Err()
}

// targetFor names the show in Stremio: an item already in the library when
// there is one, else the IMDb title (Cinemeta, what Stremio's add-ons
// find streams for), else for anime the Kitsu entry.
func (s *Service) targetFor(ctx context.Context, row progressRow, library map[string]map[string]any) (pushTarget, bool) {
	movie := row.season == 0 && row.episode == 0
	if rest, ok := strings.CutPrefix(row.seriesID, "anilist:"); ok {
		id, err := strconv.Atoi(rest)
		if err != nil || s.AniList == nil {
			return pushTarget{}, false
		}
		entry, ok := s.AniList(id)
		if !ok {
			return pushTarget{}, false
		}
		info := TitleInfo{}
		if s.Describe != nil {
			info, _ = s.Describe.StremioTitle(ctx, row.seriesID)
		}
		kitsuID := "kitsu:" + strconv.Itoa(entry.Kitsu)
		useKitsu := entry.Kitsu > 0 && (library[kitsuID] != nil || entry.IMDb == "" || !entry.HasSeason)
		if useKitsu {
			video := kitsuID
			if !movie {
				video = fmt.Sprintf("%s:%d", kitsuID, row.episode)
			}
			return pushTarget{id: kitsuID, videoID: video, name: info.Name, kind: kindOf(movie), poster: info.Poster}, entry.Kitsu > 0
		}
		if entry.IMDb == "" {
			return pushTarget{}, false
		}
		video := entry.IMDb
		if !movie {
			video = fmt.Sprintf("%s:%d:%d", entry.IMDb, entry.Season, row.episode+entry.EpisodeOffset)
		}
		return pushTarget{id: entry.IMDb, videoID: video, name: info.Name, kind: kindOf(movie), poster: info.Poster}, true
	}
	if s.Describe == nil {
		return pushTarget{}, false
	}
	info, ok := s.Describe.StremioTitle(ctx, row.seriesID)
	if !ok || !strings.HasPrefix(info.IMDb, "tt") {
		return pushTarget{}, false
	}
	video := info.IMDb
	if !movie {
		video = fmt.Sprintf("%s:%d:%d", info.IMDb, row.season, row.episode)
	}
	kind := info.Kind
	if kind == "" {
		kind = kindOf(movie)
	}
	return pushTarget{id: info.IMDb, videoID: video, name: info.Name, kind: kind, poster: info.Poster}, true
}

func kindOf(movie bool) string {
	if movie {
		return "movie"
	}
	return "series"
}

// updatedItem is the Stremio item with TorWatch's position (ok false:
// nothing to write: Stremio is newer, already there, or a peek).
func updatedItem(existing map[string]any, target pushTarget, row progressRow, now time.Time) (map[string]any, bool) {
	queued := row.positionS == 0 && row.durationS == 0 // next episode, not started
	finished := row.percent >= 90
	if !queued && !finished && row.positionS < 10 {
		return nil, false // opened for a few seconds
	}
	item := map[string]any{}
	state := map[string]any{}
	if existing != nil {
		if mtime, ok := parseTime(existing["_mtime"]); ok && !mtime.Before(row.updatedAt.Truncate(time.Second)) {
			return nil, false // changed in Stremio since: Stremio's is newer
		}
		for key, value := range existing {
			item[key] = value
		}
		if old, ok := existing["state"].(map[string]any); ok {
			for key, value := range old {
				state[key] = value
			}
		}
	} else {
		if target.name == "" {
			return nil, false // too little known to add it to the library
		}
		item["_id"] = target.id
		item["name"] = target.name
		item["type"] = target.kind
		item["poster"] = target.poster
		item["posterShape"] = "poster"
		item["_ctime"] = now.Format(time.RFC3339)
		item["behaviorHints"] = map[string]any{}
		for _, key := range []string{"timeWatched", "timeOffset", "overallTimeWatched", "timesWatched", "flaggedWatched", "duration"} {
			state[key] = 0
		}
		state["noNotif"] = false
	}

	offset := int64(row.positionS) * 1000
	duration := int64(row.durationS) * 1000
	switch {
	case queued:
		offset = 1 // as Stremio does on reaching the next episode
		duration = num(state["duration"])
	case finished:
		offset = 0
		state["timesWatched"] = max(num(state["timesWatched"]), 1)
		state["flaggedWatched"] = 1
	}
	video := target.videoID
	if old, _ := state["video_id"].(string); old == video && existing != nil {
		if math.Abs(float64(num(state["timeOffset"])-offset)) < 5000 && !finished {
			return nil, false // Stremio already has this place
		}
	} else if existing != nil {
		// Another episode: as Stremio's player does when the video changes.
		state["overallTimeWatched"] = num(state["overallTimeWatched"]) + num(state["timeWatched"])
		state["timeWatched"] = 0
		state["flaggedWatched"] = 0
		if finished {
			state["flaggedWatched"] = 1
		}
	}
	state["video_id"] = video
	state["timeOffset"] = offset
	state["duration"] = duration
	state["lastWatched"] = row.updatedAt.UTC().Format(time.RFC3339)
	item["state"] = state
	item["removed"] = false
	item["temp"] = false
	item["_mtime"] = now.Format(time.RFC3339)
	return item, true
}

func num(value any) int64 {
	switch v := value.(type) {
	case float64:
		return int64(v)
	case int64:
		return v
	case int:
		return int64(v)
	}
	return 0
}

func parseTime(value any) (time.Time, bool) {
	text, _ := value.(string)
	if text == "" {
		return time.Time{}, false
	}
	at, err := time.Parse(time.RFC3339Nano, text)
	return at, err == nil
}

// PushLoop sends progress for every profile that turned it on, every
// interval (default 30 s), until ctx ends.
func (s *Service) PushLoop(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = 30 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		accounts, err := s.Store.List(ctx)
		if err != nil {
			continue
		}
		for _, account := range accounts {
			if !account.PushEnabled || account.LastError == ErrSession.Error() {
				continue
			}
			callCtx, cancel := context.WithTimeout(ctx, time.Minute)
			if _, err := s.PushProfile(callCtx, account); err != nil {
				log.Printf("[stremio] sending to Stremio for profile %s: %v", account.ProfileID, err)
			}
			cancel()
		}
	}
}
