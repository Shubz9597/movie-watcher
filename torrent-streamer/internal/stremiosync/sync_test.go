package stremiosync

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"torrent-streamer/internal/watch"
)

type fakeTitles map[string]string

func (f fakeTitles) TitleForIMDb(_ context.Context, imdb, _ string) string { return f[imdb] }

// fakeStremio answers like api.strem.io for one account.
func fakeStremio(t *testing.T, items *atomic.Value) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		switch r.URL.Path {
		case "/api/login":
			if body["type"] != "Login" || body["email"] != "me@example.com" || body["password"] != "right" {
				_, _ = w.Write([]byte(`{"error":{"code":3,"message":"Wrong passphrase","wrongPass":true}}`))
				return
			}
			_, _ = w.Write([]byte(`{"result":{"authKey":"key-1","user":{"email":"me@example.com"}}}`))
		case "/api/datastoreGet":
			if body["authKey"] != "key-1" {
				_, _ = w.Write([]byte(`{"error":{"code":1,"message":"Session does not exist"}}`))
				return
			}
			if body["collection"] != "libraryItem" || body["all"] != true {
				t.Errorf("datastoreGet body = %v", body)
			}
			_, _ = w.Write([]byte(`{"result":` + items.Load().(string) + `}`))
		case "/api/logout":
			_, _ = w.Write([]byte(`{"result":{"success":true}}`))
		default:
			http.NotFound(w, r)
		}
	}))
}

func libraryJSON(lastWatched time.Time) string {
	at := lastWatched.UTC().Format(time.RFC3339)
	old := lastWatched.Add(-400 * 24 * time.Hour).UTC().Format(time.RFC3339)
	return `[
 {"_id":"tt0944947","name":"Game of Thrones","type":"series","removed":false,"temp":false,"_mtime":"` + at + `",
  "state":{"lastWatched":"` + at + `","timeOffset":1920000,"duration":3600000,"video_id":"tt0944947:1:3"}},
 {"_id":"tt0816692","name":"Interstellar","type":"movie","removed":true,"temp":true,"_mtime":"` + at + `",
  "state":{"lastWatched":"` + at + `","timeOffset":600000,"duration":10140000,"video_id":"tt0816692"}},
 {"_id":"kitsu:12","name":"One Piece","type":"series","removed":false,"temp":false,"_mtime":"` + at + `",
  "state":{"lastWatched":"` + at + `","timeOffset":300000,"duration":1440000,"video_id":"kitsu:12:5"}},
 {"_id":"tt1475582","name":"Sherlock","type":"series","removed":true,"temp":false,"_mtime":"` + at + `",
  "state":{"lastWatched":"` + at + `","timeOffset":300000,"duration":5400000,"video_id":"tt1475582:1:1"}},
 {"_id":"tt0903747","name":"Breaking Bad","type":"series","removed":false,"temp":false,"_mtime":"` + old + `",
  "state":{"lastWatched":"` + old + `","timeOffset":300000,"duration":2900000,"video_id":"tt0903747:1:1"}},
 {"_id":"tt0108778","name":"Friends","type":"series","removed":false,"temp":false,"_mtime":"` + at + `",
  "state":{"lastWatched":"` + at + `","timeOffset":0,"duration":0,"video_id":"tt0108778:1:1"}},
 {"_id":"tt9999999","name":"Odd","type":"series","_mtime":"not a date","state":{"lastWatched":"also not"}}
]`
}

func newService(server *httptest.Server) *Service {
	return &Service{
		Client: &Client{Base: server.URL + "/api/"},
		Titles: fakeTitles{"tt0944947": "tmdb:tv:1399", "tt0816692": "tmdb:movie:157336", "tt1475582": "tmdb:tv:19885", "tt0903747": "tmdb:tv:1396"},
		Kitsu: func(id int) (KitsuEntry, bool) {
			if id == 12 {
				return KitsuEntry{AniList: 21}, true
			}
			return KitsuEntry{}, false
		},
	}
}

func TestClientLoginAndLibrary(t *testing.T) {
	var items atomic.Value
	now := time.Now()
	items.Store(libraryJSON(now))
	server := fakeStremio(t, &items)
	defer server.Close()
	client := &Client{Base: server.URL + "/api/"}
	ctx := context.Background()

	if _, err := client.Login(ctx, "me@example.com", "wrong"); !errors.Is(err, ErrBadLogin) {
		t.Fatalf("wrong password = %v, want ErrBadLogin", err)
	}
	key, err := client.Login(ctx, "me@example.com", "right")
	if err != nil || key != "key-1" {
		t.Fatalf("login = %q, %v", key, err)
	}
	if _, err := client.Library(ctx, "stale"); !errors.Is(err, ErrSession) {
		t.Fatalf("stale session = %v, want ErrSession", err)
	}
	library, err := client.Library(ctx, key)
	if err != nil {
		t.Fatal(err)
	}
	if len(library) != 6 { // the record with bad dates is skipped
		t.Fatalf("library has %d items, want 6", len(library))
	}
}

func TestPositionsFromLibrary(t *testing.T) {
	var items atomic.Value
	now := time.Now().Truncate(time.Second)
	items.Store(libraryJSON(now))
	server := fakeStremio(t, &items)
	defer server.Close()
	service := newService(server)
	library, err := service.Client.Library(context.Background(), "key-1")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]watch.OfflineProgress{}
	since := now.Add(-60 * 24 * time.Hour)
	for _, item := range library {
		if p, ok := service.position(context.Background(), item, since); ok {
			got[item.Name] = p
		}
	}
	want := map[string]watch.OfflineProgress{
		"Game of Thrones": {SeriesID: "tmdb:tv:1399", Season: 1, Episode: 3, PositionS: 1920, DurationS: 3600, WatchedAt: now},
		// Watched without adding to the library (temp): still brought in.
		"Interstellar": {SeriesID: "tmdb:movie:157336", PositionS: 600, DurationS: 10140, WatchedAt: now},
		// Kitsu ids go through the anime list to their AniList entry.
		"One Piece": {SeriesID: "anilist:21", Season: 1, Episode: 5, PositionS: 300, DurationS: 1440, WatchedAt: now},
	}
	if len(got) != len(want) {
		t.Fatalf("positions = %+v", got)
	}
	for name, w := range want {
		g := got[name]
		if g.SeriesID != w.SeriesID || g.Season != w.Season || g.Episode != w.Episode ||
			g.PositionS != w.PositionS || g.DurationS != w.DurationS || !g.WatchedAt.Equal(w.WatchedAt) {
			t.Errorf("%s = %+v, want %+v", name, g, w)
		}
	}
}

// End to end against Postgres: link, import into the profile's Continue
// Watching, newer positions win, unlink.
func TestSyncIntoProfile(t *testing.T) {
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

	var items atomic.Value
	watchedAt := time.Now().Add(-time.Hour).Truncate(time.Second)
	items.Store(libraryJSON(watchedAt))
	server := fakeStremio(t, &items)
	defer server.Close()
	service := newService(server)
	service.Store = &Store{DB: db}
	service.Progress = progress

	if _, err := service.Link(ctx, "p-guest", "me@example.com", "wrong"); !errors.Is(err, ErrBadLogin) {
		t.Fatalf("link with a wrong password = %v", err)
	}
	account, err := service.Link(ctx, "p-guest", " me@example.com ", "right")
	if err != nil {
		t.Fatal(err)
	}
	if account.Email != "me@example.com" || account.Imported != 3 || account.LastError != "" || account.LastSyncAt == nil {
		t.Fatalf("account after link = %+v", account)
	}
	var stored string
	_ = db.QueryRowContext(ctx, `SELECT auth_key FROM stremio_accounts WHERE profile_id='p-guest'`).Scan(&stored)
	if stored != "key-1" {
		t.Fatalf("stored key = %q", stored)
	}

	continueItems, err := progress.ListContinue(ctx, "p-guest", 20)
	if err != nil {
		t.Fatal(err)
	}
	found := map[string]bool{}
	for _, item := range continueItems {
		found[item.SeriesID] = true
	}
	if !found["tmdb:tv:1399"] || !found["tmdb:movie:157336"] {
		t.Fatalf("continue watching = %+v", continueItems)
	}
	// The household profile is untouched.
	if other, _ := progress.ListContinue(ctx, "household", 20); len(other) != 0 {
		t.Fatalf("household got %+v", other)
	}

	// Same library again: nothing new.
	account, err = service.SyncProfile(ctx, "p-guest")
	if err != nil || account.Imported != 3 {
		t.Fatalf("second sync = %+v, %v", account, err)
	}

	// Watched further in this app since: an older Stremio position does not
	// pull it back.
	if _, err := db.ExecContext(ctx, `UPDATE watch_progress SET position_s=2500 WHERE subject_id='p-guest' AND series_id='tmdb:tv:1399'`); err != nil {
		t.Fatal(err)
	}
	if _, err := service.SyncProfile(ctx, "p-guest"); err != nil {
		t.Fatal(err)
	}
	var position int
	_ = db.QueryRowContext(ctx, `SELECT position_s FROM watch_progress WHERE subject_id='p-guest' AND series_id='tmdb:tv:1399' AND season=1 AND episode=3`).Scan(&position)
	if position != 2500 {
		t.Fatalf("older Stremio position overwrote newer: %d", position)
	}

	// Watched further on the TV later: it wins.
	items.Store(strings.Replace(libraryJSON(time.Now().Add(time.Minute)), `"timeOffset":1920000`, `"timeOffset":3000000`, 1))
	if _, err := service.SyncProfile(ctx, "p-guest"); err != nil {
		t.Fatal(err)
	}
	_ = db.QueryRowContext(ctx, `SELECT position_s FROM watch_progress WHERE subject_id='p-guest' AND series_id='tmdb:tv:1399' AND season=1 AND episode=3`).Scan(&position)
	if position != 3000 {
		t.Fatalf("newer Stremio position not applied: %d", position)
	}

	if err := service.Unlink(ctx, "p-guest"); err != nil {
		t.Fatal(err)
	}
	if _, linked, _ := service.Store.Get(ctx, "p-guest"); linked {
		t.Fatal("still linked after unlink")
	}
}
