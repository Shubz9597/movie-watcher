package animemap

import (
	"os"
	"testing"
)

// A slice of the real list: Dragon Ball Z Kai, Demon Slayer, One Piece,
// Frieren and Attack on Titan's split third season.
func sample(t *testing.T) *Map {
	t.Helper()
	data, err := os.ReadFile("testdata/anime-list-sample.json")
	if err != nil {
		t.Fatal(err)
	}
	m, err := Parse(data)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func TestEntriesPlacedInTheirShow(t *testing.T) {
	m := sample(t)
	for _, c := range []struct {
		anilist, tmdb, season, offset int
		imdb                          string
	}{
		{6033, 61709, 1, 0, "tt1409055"},     // Dragon Ball Z Kai
		{20635, 61709, 2, 0, "tt1409055"},    // The Final Chapters
		{142329, 85937, 3, 0, "tt9335498"},   // Demon Slayer: Entertainment District
		{104578, 1429, 3, 12, "tt2560140"},   // Attack on Titan S3 part 2
		{182255, 209867, 2, 0, "tt22248376"}, // Frieren season 2 (TVDB numbering)
	} {
		e, ok := m.AniList(c.anilist)
		if !ok || e.TMDbTV != c.tmdb || !e.HasSeason || e.Season != c.season || e.EpisodeOffset != c.offset || len(e.IMDb) == 0 || e.IMDb[0] != c.imdb {
			t.Fatalf("anilist %d: %+v", c.anilist, e)
		}
	}
	if op, ok := m.AniList(21); !ok || op.HasSeason {
		t.Fatalf("One Piece spans every season: %+v", op)
	}
	if got := m.SeasonEntries("tt1409055", 0, 2); len(got) != 1 || got[0].AniList != 20635 {
		t.Fatalf("Kai season 2: %+v", got)
	}
	if got := m.SeasonEntries("tt2560140", 0, 3); len(got) != 2 || got[0].EpisodeOffset != 0 || got[1].AniList != 104578 {
		t.Fatalf("AoT season 3 halves: %+v", got)
	}
	if !m.IsAnime("tt9335498", 0) || m.IsAnime("tt0306414", 0) {
		t.Fatal("anime flag")
	}
	var empty *Map
	if _, ok := empty.AniList(6033); ok || empty.IsAnime("tt1409055", 0) {
		t.Fatal("nil map finds nothing")
	}
}
