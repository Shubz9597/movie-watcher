package introdetect

import (
	"context"
	"database/sql"
	"os"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"

	"torrent-streamer/migrations"
)

func testDB(t *testing.T) *sql.DB {
	dsn := os.Getenv("TORWATCH_TEST_PG_DSN")
	if dsn == "" {
		t.Skip("TORWATCH_TEST_PG_DSN not set")
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err := migrations.Apply(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	return db
}

// Fingerprints and songs survive a round trip; a show's other episodes
// come back nearest first; detection runs from stored fingerprints alone.
func TestStoreKeepsWhatDetectionNeeds(t *testing.T) {
	ctx := context.Background()
	store := &Store{DB: testDB(t)}
	series := "anilist:test-" + t.Name()
	for _, f := range dbzEpisodes(t) {
		ref := Ref{InfoHash: "abc" + f.Key, FileIndex: f.Episode, SeriesKey: series, Season: f.Season, Episode: f.Episode, ShowKind: "anime"}
		if err := store.SaveFile(ctx, ref, f); err != nil {
			t.Fatal(err)
		}
	}
	target := Ref{InfoHash: "abcep15", FileIndex: 15, SeriesKey: series, Season: 1, Episode: 15}
	file, ok, err := store.LoadFile(ctx, target.InfoHash, target.FileIndex)
	if err != nil || !ok || len(file.Head) != 2 || len(file.Tail) != 1 || file.Tail[0].Start != dbzTailStart {
		t.Fatalf("load: ok=%v err=%v head=%d", ok, err, len(file.Head))
	}
	others, err := store.Neighbours(ctx, target, 8)
	if err != nil || len(others) != 2 || others[0].Episode != 16 {
		t.Fatalf("neighbours: %v %+v", err, others)
	}
	result, learned := Detect(file, others, nil, AnimeProfile)
	near(t, "ep15 intro", result.Intro, 26.3, 109.7, 1.5)
	for i, theme := range learned {
		theme.Source = "episodes:test:" + string(rune('a'+i))
		if err := store.SaveTheme(ctx, series, theme); err != nil {
			t.Fatal(err)
		}
	}
	themes, err := store.Themes(ctx, series)
	if err != nil || len(themes) != len(learned) {
		t.Fatalf("themes: %v, %d of %d", err, len(themes), len(learned))
	}
	if has, _ := store.HasTheme(ctx, series, "episodes:test:a"); !has {
		t.Fatal("HasTheme")
	}
	again, _ := Detect(file, nil, themes, AnimeProfile)
	if again.Intro == nil || again.Intro.Method != "theme" {
		t.Fatalf("stored songs not found again: %+v", again)
	}
}
