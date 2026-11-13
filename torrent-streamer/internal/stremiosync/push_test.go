package stremiosync

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
	"time"

	"torrent-streamer/internal/watch"
)

type fakeDescriber map[string]TitleInfo

func (f fakeDescriber) StremioTitle(_ context.Context, id string) (TitleInfo, bool) {
	info, ok := f[id]
	return info, ok
}

// fakeLibrary is a Stremio account library that records what is written.
type fakeLibrary struct {
	mu    sync.Mutex
	items []map[string]any
	puts  [][]map[string]any
}

func (f *fakeLibrary) server(t *testing.T) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["authKey"] != "key-1" {
			_, _ = w.Write([]byte(`{"error":{"code":1,"message":"Session does not exist"}}`))
			return
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		switch r.URL.Path {
		case "/api/datastoreGet":
			raw, _ := json.Marshal(map[string]any{"result": f.items})
			_, _ = w.Write(raw)
		case "/api/datastorePut":
			var changes []map[string]any
			raw, _ := json.Marshal(body["changes"])
			_ = json.Unmarshal(raw, &changes)
			f.puts = append(f.puts, changes)
			_, _ = w.Write([]byte(`{"result":{"success":true}}`))
		default:
			http.NotFound(w, r)
		}
	}))
}

func stored(id, video string, offset int, mtime time.Time) map[string]any {
	return map[string]any{
		"_id": id, "name": id, "type": "series", "removed": false, "temp": false,
		"_ctime": "2025-01-01T00:00:00Z", "_mtime": mtime.UTC().Format(time.RFC3339),
		"behaviorHints": map[string]any{"defaultVideoId": nil}, "posterShape": "poster",
		"state": map[string]any{
			"lastWatched": mtime.UTC().Format(time.RFC3339), "timeWatched": 600000, "timeOffset": offset,
			"overallTimeWatched": 1000000, "timesWatched": 0, "flaggedWatched": 0, "duration": 3600000,
			"video_id": video, "watched": "tt0944947:1:1:5:eJyrrgUAAXUA+Q==", "noNotif": false,
		},
	}
}

func TestPushWritesTorWatchProgressToStremio(t *testing.T) {
	dsn := os.Getenv("TORWATCH_TEST_PG_DSN")
	if dsn == "" {
		t.Skip("TORWATCH_TEST_PG_DSN not set")
	}
	ctx := context.Background()
	progress, err := watch.NewTestStore(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer progress.Close()
	db := progress.DB
	for _, table := range []string{"stremio_accounts", "watch_progress"} {
		if _, err := db.ExecContext(ctx, `DELETE FROM `+table); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO library_household (id, revision) VALUES (7, 0) ON CONFLICT DO NOTHING;
INSERT INTO profiles (id, name, household_id) VALUES ('p-guest', 'Guest', 7) ON CONFLICT DO NOTHING`); err != nil {
		t.Fatal(err)
	}
	earlier := time.Now().Add(-2 * time.Hour)
	later := time.Now().Add(time.Hour)
	library := &fakeLibrary{items: []map[string]any{
		stored("tt0944947", "tt0944947:1:2", 1200000, earlier), // Game of Thrones, at E2 in Stremio
		stored("tt1475582", "tt1475582:1:1", 600000, later),    // Sherlock: changed in Stremio since
		stored("kitsu:12", "kitsu:12:3", 300000, earlier),      // One Piece, the Kitsu way
	}}
	server := library.server(t)
	defer server.Close()
	store := &Store{DB: db}
	service := &Service{
		Store:  store,
		Client: &Client{Base: server.URL + "/api/"},
		Describe: fakeDescriber{
			"tmdb:tv:1399":      {IMDb: "tt0944947", Name: "Game of Thrones", Kind: "series"},
			"tmdb:movie:157336": {IMDb: "tt0816692", Name: "Interstellar", Kind: "movie", Poster: "https://img/interstellar.jpg"},
			"tmdb:tv:1396":      {IMDb: "tt0903747", Name: "Breaking Bad", Kind: "series"},
			"tmdb:tv:19885":     {IMDb: "tt1475582", Name: "Sherlock", Kind: "series"},
			"tmdb:tv:999":       {IMDb: "tt0000999", Name: "Peeked", Kind: "series"},
		},
		AniList: func(id int) (AnimeEntry, bool) {
			if id == 21 {
				return AnimeEntry{Kitsu: 12, IMDb: "tt0388629", Season: 1, HasSeason: false}, true
			}
			return AnimeEntry{}, false
		},
	}
	if err := store.Link(ctx, "p-guest", "me@example.com", "key-1"); err != nil {
		t.Fatal(err)
	}
	if err := store.SetPush(ctx, "p-guest", true); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
INSERT INTO watch_progress (subject_id, series_id, season, episode, position_s, duration_s, percent) VALUES
 ('p-guest', 'tmdb:tv:1399', 1, 3, 1920, 3600, 53.3),
 ('p-guest', 'tmdb:movie:157336', 0, 0, 600, 10140, 5.9),
 ('p-guest', 'tmdb:tv:1396', 1, 1, 2900, 2900, 100),
 ('p-guest', 'tmdb:tv:19885', 1, 2, 1000, 5400, 18.5),
 ('p-guest', 'tmdb:tv:999', 1, 1, 3, 3000, 0.1),
 ('p-guest', 'anilist:21', 1, 5, 700, 1440, 48.6);
INSERT INTO watch_progress (subject_id, series_id, season, episode, position_s, duration_s, percent) VALUES
 ('p-guest', 'tmdb:tv:1396', 1, 2, 0, 0, 0)`); err != nil {
		t.Fatal(err)
	}

	account, _, _ := store.Get(ctx, "p-guest")
	written, err := service.PushProfile(ctx, account)
	if err != nil {
		t.Fatal(err)
	}
	if written != 4 || len(library.puts) != 1 {
		t.Fatalf("written %d in %d put(s): %+v", written, len(library.puts), library.puts)
	}
	got := map[string]map[string]any{}
	for _, item := range library.puts[0] {
		got[item["_id"].(string)] = item
	}
	state := func(id string) map[string]any { return got[id]["state"].(map[string]any) }

	// Game of Thrones: on to E3 at 32:00; Stremio's own fields kept.
	if s := state("tt0944947"); s["video_id"] != "tt0944947:1:3" || s["timeOffset"] != float64(1920000) || s["duration"] != float64(3600000) ||
		s["watched"] != "tt0944947:1:1:5:eJyrrgUAAXUA+Q==" || s["overallTimeWatched"] != float64(1600000) || s["timeWatched"] != float64(0) {
		t.Fatalf("Game of Thrones state = %+v", s)
	}
	if hints, ok := got["tt0944947"]["behaviorHints"].(map[string]any); !ok || len(hints) != 1 || got["tt0944947"]["removed"] != false {
		t.Fatalf("Game of Thrones item = %+v", got["tt0944947"])
	}
	// Interstellar: not in the library yet, added with what Stremio needs.
	if item := got["tt0816692"]; item["name"] != "Interstellar" || item["type"] != "movie" || item["poster"] != "https://img/interstellar.jpg" ||
		state("tt0816692")["video_id"] != "tt0816692" || state("tt0816692")["timeOffset"] != float64(600000) {
		t.Fatalf("Interstellar = %+v", item)
	}
	// Breaking Bad: E1 finished, E2 up next, as Stremio records it.
	if s := state("tt0903747"); s["video_id"] != "tt0903747:1:2" || s["timeOffset"] != float64(1) {
		t.Fatalf("Breaking Bad state = %+v", s)
	}
	// One Piece: the library's Kitsu item, episode 5.
	if s := state("kitsu:12"); s["video_id"] != "kitsu:12:5" || s["timeOffset"] != float64(700000) {
		t.Fatalf("One Piece state = %+v", s)
	}
	if _, ok := got["tt1475582"]; ok {
		t.Fatal("Sherlock changed in Stremio since: must be left alone")
	}
	if _, ok := got["tt0000999"]; ok {
		t.Fatal("a few seconds' peek must not be sent")
	}
	for id, item := range got {
		if _, err := time.Parse(time.RFC3339, item["_mtime"].(string)); err != nil {
			t.Fatalf("%s _mtime = %v", id, item["_mtime"])
		}
	}

	// Sent once: the next run has nothing new.
	account, _, _ = store.Get(ctx, "p-guest")
	if account.LastPushAt == nil || account.Pushed != 4 {
		t.Fatalf("account after push = %+v", account)
	}
	if written, err := service.PushProfile(ctx, account); err != nil || written != 0 || len(library.puts) != 1 {
		t.Fatalf("second push wrote %d (%v), puts %d", written, err, len(library.puts))
	}
}

func TestUpdatedItemSkipsWhatStremioAlreadyHas(t *testing.T) {
	now := time.Now().UTC()
	row := progressRow{seriesID: "tmdb:tv:1399", season: 1, episode: 2, positionS: 1202, durationS: 3600, percent: 33, updatedAt: now.Add(-time.Minute)}
	existing := stored("tt0944947", "tt0944947:1:2", 1200000, now.Add(-time.Hour))
	target := pushTarget{id: "tt0944947", videoID: "tt0944947:1:2", name: "Game of Thrones", kind: "series"}
	if _, ok := updatedItem(existing, target, row, now); ok {
		t.Fatal("2 seconds apart on the same episode: nothing to write (no echo of an import)")
	}
	row.positionS = 2400
	if item, ok := updatedItem(existing, target, row, now); !ok || item["state"].(map[string]any)["timeOffset"] != int64(2400000) {
		t.Fatalf("further along: %+v %v", item, ok)
	}
	if _, ok := updatedItem(nil, pushTarget{id: "tt1", videoID: "tt1"}, row, now); ok {
		t.Fatal("an unknown title (no name) is not added to the library")
	}
}
