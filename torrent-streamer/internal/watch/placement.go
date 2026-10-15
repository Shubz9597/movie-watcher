package watch

import (
	"context"
	"strings"
)

// Placer finds where an AniList entry's episodes sit in its show. Show
// pages (tmdb:tv:N, Stremio's seasons) own a show's progress; an AniList
// entry (one season or arc of it) is only another name for part of it.
// Clients that still send an entry id (the phone's earlier downloads) are
// written to and read from the show.
type Placer interface {
	// PlaceEpisode maps the entry's episode N to the show's season and
	// episode.
	PlaceEpisode(ctx context.Context, seriesID string, episode int) (show string, season, number int, ok bool)
	// EntrySeason is the show season the entry fills, from episode
	// offset+1 (ok false when the entry spans seasons or is unknown).
	EntrySeason(ctx context.Context, seriesID string) (show string, season, offset int, ok bool)
}

func isEntryID(seriesID string) bool { return strings.HasPrefix(seriesID, "anilist:") }

// place moves one episode of an entry to its show; other ids pass through.
// Season 0 (a film's progress) is never moved.
func (s *Store) place(ctx context.Context, seriesID string, season, episode int) (string, int, int) {
	if s.Placer == nil || !isEntryID(seriesID) || season <= 0 || episode <= 0 {
		return seriesID, season, episode
	}
	if show, showSeason, number, ok := s.Placer.PlaceEpisode(ctx, seriesID, episode); ok {
		return show, showSeason, number
	}
	return seriesID, season, episode
}

// entryView reads an entry's episodes from its show: the show id, its
// season and the offset to subtract (ok false: read the id as it is).
func (s *Store) entryView(ctx context.Context, seriesID string) (show string, season, offset int, ok bool) {
	if s.Placer == nil || !isEntryID(seriesID) {
		return "", 0, 0, false
	}
	return s.Placer.EntrySeason(ctx, seriesID)
}
