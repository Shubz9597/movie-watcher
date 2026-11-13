package stremiosync

import (
	"context"
	"errors"
	"log"
	"strconv"
	"strings"
	"sync"
	"time"

	"torrent-streamer/internal/watch"
)

// Titles maps an IMDb id to the catalog's title id (catalog.Service).
type Titles interface {
	TitleForIMDb(ctx context.Context, imdb, kind string) string
}

// Progress applies positions to a profile (watch.Store).
type Progress interface {
	ImportProgress(ctx context.Context, profileID string, items []watch.OfflineProgress) (int, error)
}

// KitsuEntry is what the anime list knows of a Kitsu id: its AniList entry
// and, for a film, its TMDb movie id.
type KitsuEntry struct {
	AniList   int
	TMDbMovie int
}

type Service struct {
	Store    *Store
	Client   *Client
	Titles   Titles
	Progress Progress
	// Kitsu looks up Stremio's anime add-on ids (nil: those are skipped).
	Kitsu func(id int) (KitsuEntry, bool)
	// Interval between automatic syncs (default 3 minutes).
	Interval time.Duration
	// MaxAge: older watches are not brought in (default 60 days), so linking
	// does not fill Continue Watching with years-old titles.
	MaxAge time.Duration

	// LinkWait: how long a link code waits for approval (default 10
	// minutes); LinkPoll: how often the server checks it (default 3 s).
	LinkWait time.Duration
	LinkPoll time.Duration

	mu sync.Mutex // one sync at a time

	pendingMu sync.Mutex
	pending   map[string]*pendingState // per profile: a code waiting for approval
}

// Link signs in to Stremio, keeps the session for the profile and syncs
// once.
func (s *Service) Link(ctx context.Context, profileID, email, password string) (Account, error) {
	email = strings.TrimSpace(email)
	key, err := s.Client.Login(ctx, email, password)
	if err != nil {
		return Account{}, err
	}
	if err := s.Store.Link(ctx, profileID, email, key); err != nil {
		return Account{}, err
	}
	return s.SyncProfile(ctx, profileID)
}

// Unlink forgets the profile's account and ends its Stremio session.
func (s *Service) Unlink(ctx context.Context, profileID string) error {
	account, ok, err := s.Store.Get(ctx, profileID)
	if err != nil || !ok {
		return err
	}
	if err := s.Store.Unlink(ctx, profileID); err != nil {
		return err
	}
	logoutCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	_ = s.Client.Logout(logoutCtx, account.AuthKey)
	return nil
}

// SyncProfile reads the profile's Stremio library and applies its positions.
// The account's status (last sync, error, total imported) is updated either
// way and returned.
func (s *Service) SyncProfile(ctx context.Context, profileID string) (Account, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	account, ok, err := s.Store.Get(ctx, profileID)
	if err != nil {
		return Account{}, err
	}
	if !ok {
		return Account{}, errors.New("no Stremio account is linked")
	}
	applied, syncErr := s.sync(ctx, account)
	message := ""
	if syncErr != nil {
		message = syncErr.Error()
		log.Printf("[stremio] sync for profile %s: %v", profileID, syncErr)
	} else if applied > 0 {
		log.Printf("[stremio] profile %s: %d position(s) from Stremio", profileID, applied)
	}
	if err := s.Store.Record(ctx, profileID, applied, message); err != nil {
		return Account{}, err
	}
	account, _, err = s.Store.Get(ctx, profileID)
	if err == nil && syncErr != nil {
		err = syncErr
	}
	return account, err
}

func (s *Service) sync(ctx context.Context, account Account) (int, error) {
	items, err := s.Client.Library(ctx, account.AuthKey)
	if err != nil {
		return 0, err
	}
	maxAge := s.MaxAge
	if maxAge <= 0 {
		maxAge = 60 * 24 * time.Hour
	}
	since := time.Now().Add(-maxAge)
	var positions []watch.OfflineProgress
	for _, item := range items {
		if position, ok := s.position(ctx, item, since); ok {
			positions = append(positions, position)
		}
	}
	if len(positions) == 0 {
		return 0, nil
	}
	return s.Progress.ImportProgress(ctx, account.ProfileID, positions)
}

// position turns a library item into the position Stremio last saved for it
// (ok false: nothing to bring in).
func (s *Service) position(ctx context.Context, item LibraryItem, since time.Time) (watch.OfflineProgress, bool) {
	state := item.State
	if item.Removed && !item.Temp {
		return watch.OfflineProgress{}, false // taken out of the library
	}
	if state.LastWatched == nil || state.LastWatched.Before(since) {
		return watch.OfflineProgress{}, false
	}
	positionS, durationS := int(state.TimeOffset/1000), int(state.Duration/1000)
	if positionS < 10 || durationS <= 0 || positionS > durationS {
		return watch.OfflineProgress{}, false
	}
	video := state.VideoID
	if video == "" {
		video = item.ID
	}
	parts := strings.Split(video, ":")
	out := watch.OfflineProgress{PositionS: positionS, DurationS: durationS, WatchedAt: *state.LastWatched}
	switch {
	case strings.HasPrefix(parts[0], "tt"):
		// "tt0944947:1:3" (series episode) or "tt0816692" (film).
		if len(parts) == 3 {
			season, errS := strconv.Atoi(parts[1])
			episode, errE := strconv.Atoi(parts[2])
			if errS != nil || errE != nil || season < 0 || episode <= 0 {
				return watch.OfflineProgress{}, false
			}
			out.Season, out.Episode = season, episode
		} else if len(parts) != 1 || item.Type == "series" {
			return watch.OfflineProgress{}, false
		}
		kind := "movie"
		if out.Episode > 0 {
			kind = "series"
		}
		out.SeriesID = s.Titles.TitleForIMDb(ctx, parts[0], kind)
	case parts[0] == "kitsu" && len(parts) >= 2 && s.Kitsu != nil:
		// Stremio's anime add-on: "kitsu:<id>:<episode>", or "kitsu:<id>"
		// for a film.
		id, err := strconv.Atoi(parts[1])
		if err != nil {
			return watch.OfflineProgress{}, false
		}
		entry, ok := s.Kitsu(id)
		if !ok {
			return watch.OfflineProgress{}, false
		}
		if len(parts) >= 3 {
			episode, err := strconv.Atoi(parts[len(parts)-1])
			if err != nil || episode <= 0 || entry.AniList <= 0 {
				return watch.OfflineProgress{}, false
			}
			// An AniList entry's episode; progress places it in its show.
			out.SeriesID, out.Season, out.Episode = "anilist:"+strconv.Itoa(entry.AniList), 1, episode
		} else if entry.TMDbMovie > 0 {
			out.SeriesID = "tmdb:movie:" + strconv.Itoa(entry.TMDbMovie)
		}
	}
	return out, out.SeriesID != ""
}

// Run syncs every linked profile now and then until ctx ends.
func (s *Service) Run(ctx context.Context) {
	interval := s.Interval
	if interval <= 0 {
		interval = 3 * time.Minute
	}
	timer := time.NewTimer(30 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		accounts, err := s.Store.List(ctx)
		if err != nil {
			log.Printf("[stremio] listing accounts: %v", err)
		}
		for _, account := range accounts {
			if account.LastError == ErrSession.Error() {
				continue // waits for the profile to link again
			}
			callCtx, cancel := context.WithTimeout(ctx, time.Minute)
			_, _ = s.SyncProfile(callCtx, account.ProfileID)
			cancel()
		}
		timer.Reset(interval)
	}
}
