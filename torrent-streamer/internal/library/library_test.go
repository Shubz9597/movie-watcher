package library

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"strconv"
	"sync"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib" // database/sql driver

	"torrent-streamer/internal/catalog"
	"torrent-streamer/migrations"
)

// testDB opens a per-test isolated schema over the disposable PostgreSQL
// (TORWATCH_TEST_PG_DSN), applies the full embedded migration set to it, and
// returns a Store over that schema. Tests skip (pending, never pass) when no
// disposable database is configured.
func testDB(t *testing.T) (*sql.DB, *Store, *fakeResolver) {
	t.Helper()
	base := os.Getenv("TORWATCH_TEST_PG_DSN")
	if base == "" {
		t.Skip("TORWATCH_TEST_PG_DSN not set; M3.2 storage verification pending a disposable database")
	}
	schema := fmt.Sprintf("libtest_%d_%d", time.Now().UnixNano(), os.Getpid())
	// pgx passes unknown DSN query params to the server as session parameters.
	dsn := base + "&search_path=" + schema
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatalf("open test schema: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	ctx := context.Background()
	if _, err := db.ExecContext(ctx, `CREATE SCHEMA `+schema); err != nil {
		t.Fatalf("create schema %s: %v", schema, err)
	}
	if err := migrations.Apply(ctx, db); err != nil {
		t.Fatalf("apply migrations to %s: %v", schema, err)
	}
	resolver := &fakeResolver{titles: defaultFakeTitles()}
	store, err := NewStore(ctx, db, resolver)
	if err != nil {
		t.Fatalf("open library store: %v", err)
	}
	return db, store, resolver
}

func defaultFakeTitles() map[string]Metadata {
	return map[string]Metadata{
		"tmdb:movie:693134": {Title: "Dune: Part Two", Year: 2024, Poster: "https://image.test/dune.jpg", Kind: KindMovie, SortKey: "dune part two"},
		"tmdb:tv:1396":      {Title: "Breaking Bad", Year: 2008, Poster: "https://image.test/bb.jpg", Kind: KindSeries, SortKey: "breaking bad"},
		"tmdb:tv:209867":    {Title: "Frieren: Beyond Journey's End", Year: 2023, Poster: "https://image.test/frieren.jpg", Kind: KindAnime, SortKey: "frieren beyond journeys end"},
		"anilist:154587":    {Title: "Frieren: Beyond Journey's End", Year: 2023, Poster: "https://image.test/frieren.jpg", Kind: KindAnime, SortKey: "frieren beyond journeys end"},
		"tmdb:movie:123":    {Title: "Collision Movie", Year: 2020, Kind: KindMovie, SortKey: "collision movie"},
		"tmdb:tv:123":       {Title: "Collision Series", Year: 2021, Kind: KindSeries, SortKey: "collision series"},
		"tmdb:movie:500":    {Title: "500 Movie", Year: 2019, Kind: KindMovie, SortKey: "500 movie"},
		"tmdb:movie:42":     {Title: "Alpha", Year: 2001, Kind: KindMovie, SortKey: "alpha"},
		"tmdb:movie:7":      {Title: "Zulu", Year: 2002, Kind: KindMovie, SortKey: "zulu"},
		"tmdb:movie:11":     {Title: "mIxEd Case", Year: 2003, Kind: KindMovie, SortKey: "mixed case"},
		"tmdb:movie:99":     {Title: "Vanishing", Year: 2004, Kind: KindMovie, SortKey: "vanishing"},
	}
}

// fakeResolver counts calls so tests can prove reads never fan out to
// providers (N+1-free reads) and can make titles disappear.
type fakeResolver struct {
	mu     sync.Mutex
	titles map[string]Metadata
	calls  int
}

func (f *fakeResolver) Resolve(_ context.Context, canonicalID string) (Metadata, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	meta, ok := f.titles[canonicalID]
	if !ok {
		return Metadata{}, catalog.ErrNotFound
	}
	return meta, nil
}

func (f *fakeResolver) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func (f *fakeResolver) remove(canonicalID string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.titles, canonicalID)
}

func write(t *testing.T, store *Store, id, field string, enabled bool) WriteResult {
	t.Helper()
	result, err := store.Write(context.Background(), Write{CanonicalID: id, Field: field, Enabled: enabled})
	if err != nil {
		t.Fatalf("write %s %s=%v: %v", id, field, enabled, err)
	}
	return result
}

func TestEmptyDatabaseReads(t *testing.T) {
	_, store, _ := testDB(t)
	ctx := context.Background()
	page, err := store.Page(ctx, CollectionWatchLater, KindAll, SortRecent, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 0 || len(page.Items) != 0 || page.NextCursor != "" {
		t.Fatalf("empty page = %+v", page)
	}
	if RevisionString(page.Revision) != "0" {
		t.Fatalf("empty revision = %q, want \"0\"", RevisionString(page.Revision))
	}
	overview, err := store.Overview(ctx, CollectionFavourites, SortTitle)
	if err != nil {
		t.Fatal(err)
	}
	if len(overview.Shelves) != 3 {
		t.Fatalf("shelves = %d, want 3 (movie/series/anime always present)", len(overview.Shelves))
	}
	for _, shelf := range overview.Shelves {
		if shelf.Count != 0 || len(shelf.Previews) != 0 {
			t.Fatalf("zero shelf not empty: %+v", shelf)
		}
	}
}

func TestFirstInsertRetryAndNoop(t *testing.T) {
	_, store, _ := testDB(t)
	ctx := context.Background()

	first := write(t, store, "tmdb:movie:693134", CollectionWatchLater, true)
	if !first.WatchLater || first.Favourite {
		t.Fatalf("first write flags = %+v", first)
	}
	if RevisionString(first.Revision) != "1" {
		t.Fatalf("first revision = %q, want \"1\"", RevisionString(first.Revision))
	}

	// Retry of the same value: no-op — same revision, no reorder.
	retry := write(t, store, "tmdb:movie:693134", CollectionWatchLater, true)
	if retry.Revision != first.Revision {
		t.Fatalf("retry revision = %d, want %d", retry.Revision, first.Revision)
	}
	time.Sleep(10 * time.Millisecond) // let a wrongly-bumped added timestamp diverge

	// Writing the OTHER flag false on an untouched row is also a no-op that
	// returns committed state without advancing the revision.
	noOp := write(t, store, "tmdb:movie:693134", CollectionFavourites, false)
	if noOp.Revision != first.Revision || noOp.Favourite {
		t.Fatalf("favourite no-op = %+v", noOp)
	}

	// The retained both-false row explains removals but appears in no collection.
	for _, collection := range []string{CollectionWatchLater, CollectionFavourites} {
		page, err := store.Page(ctx, collection, KindAll, SortRecent, "", 0)
		if err != nil {
			t.Fatal(err)
		}
		if collection == CollectionFavourites && len(page.Items) != 0 {
			t.Fatalf("inactive row leaked into %s: %+v", collection, page.Items)
		}
	}

	page, err := store.Page(ctx, CollectionWatchLater, KindAll, SortRecent, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].CanonicalID != "tmdb:movie:693134" ||
		page.Items[0].Type != KindMovie || page.Items[0].Title != "Dune: Part Two" ||
		!page.Items[0].MetadataAvailable {
		t.Fatalf("page after first insert = %+v", page.Items)
	}
	if page.Items[0].Artwork["poster"] != "https://image.test/dune.jpg" {
		t.Fatalf("snapshot poster missing: %+v", page.Items[0])
	}
}

func TestIndependentFlagsAndTimestamps(t *testing.T) {
	_, store, _ := testDB(t)
	ctx := context.Background()
	id := "tmdb:tv:1396"
	wl := write(t, store, id, CollectionWatchLater, true)
	fav := write(t, store, id, CollectionFavourites, true)
	if fav.Revision != wl.Revision+1 {
		t.Fatalf("revisions = %d then %d, want sequential", wl.Revision, fav.Revision)
	}

	// Removing one flag never touches the other.
	removed := write(t, store, id, CollectionWatchLater, false)
	if removed.Revision != fav.Revision+1 {
		t.Fatalf("removal revision = %d", removed.Revision)
	}
	if !removed.Favourite {
		t.Fatalf("favourite flag lost by watch-later removal: %+v", removed)
	}
	page, err := store.Page(ctx, CollectionFavourites, KindAll, SortRecent, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || !page.Items[0].AddedAt.After(time.Time{}) {
		t.Fatalf("favourite membership lost its added timestamp: %+v", page.Items)
	}
}

func TestRemoveAndReAddReorders(t *testing.T) {
	_, store, _ := testDB(t)
	ctx := context.Background()
	write(t, store, "tmdb:movie:693134", CollectionWatchLater, true)
	time.Sleep(5 * time.Millisecond)
	write(t, store, "tmdb:tv:1396", CollectionWatchLater, true)

	page, err := store.Page(ctx, CollectionWatchLater, KindAll, SortRecent, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	if page.Items[0].CanonicalID != "tmdb:tv:1396" {
		t.Fatalf("recent order wrong before re-add: %+v", page.Items)
	}
	originalAdded := page.Items[0].AddedAt

	write(t, store, "tmdb:movie:693134", CollectionWatchLater, false)
	time.Sleep(5 * time.Millisecond)
	write(t, store, "tmdb:movie:693134", CollectionWatchLater, true)

	page, err = store.Page(ctx, CollectionWatchLater, KindAll, SortRecent, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	if page.Items[0].CanonicalID != "tmdb:movie:693134" {
		t.Fatalf("re-added entry did not reorder to the top: %+v", page.Items)
	}
	if !page.Items[0].AddedAt.After(originalAdded) {
		t.Fatalf("re-add did not set a fresh added timestamp: %v vs %v", page.Items[0].AddedAt, originalAdded)
	}
}

func TestOpposingConcurrentWritesToSameField(t *testing.T) {
	_, store, _ := testDB(t)
	id := "tmdb:tv:1396"
	write(t, store, id, CollectionWatchLater, false) // retained both-false row

	const goroutines = 8
	results := make([]WriteResult, goroutines)
	errs := make([]error, goroutines)
	var start sync.WaitGroup
	start.Add(1)
	var wg sync.WaitGroup
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			start.Wait()
			results[i], errs[i] = store.Write(context.Background(), Write{
				CanonicalID: id, Field: CollectionWatchLater, Enabled: i%2 == 0,
			})
		}(i)
	}
	start.Done()
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("concurrent write %d failed: %v", i, err)
		}
	}

	// Commit-order resolution: the final committed state is the last
	// committer's flag. Revisions strictly increase per effective change, so
	// the highest returned revision IS the committed household revision and
	// its response owns the final flag. A final false commit retains the row
	// with both flags false, so the collection total may be 0 or 1.
	ctx := context.Background()
	page, err := store.Page(ctx, CollectionWatchLater, KindAll, SortRecent, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total > 1 {
		t.Fatalf("concurrent writes duplicated memberships: total=%d", page.Total)
	}
	var maxReturned int64
	var finalFlag bool
	for _, result := range results {
		if result.Revision > maxReturned {
			maxReturned = result.Revision
			finalFlag = result.WatchLater
		}
	}
	if maxReturned != page.Revision {
		t.Fatalf("max returned revision %d != committed snapshot revision %d", maxReturned, page.Revision)
	}
	var storedFlag bool
	if err := store.DB.QueryRowContext(ctx,
		`SELECT watch_later FROM library_memberships WHERE canonical_id=$1`, id).Scan(&storedFlag); err != nil {
		t.Fatal(err)
	}
	if storedFlag != finalFlag {
		t.Fatalf("committed row %v contradicts the last writer's response %v", storedFlag, finalFlag)
	}
	if finalFlag != (page.Total == 1) {
		t.Fatalf("collection total %d contradicts the committed flag %v", page.Total, finalFlag)
	}
}

func TestParallelWritesToDifferentFields(t *testing.T) {
	_, store, _ := testDB(t)
	id := "tmdb:tv:1396"
	var wg sync.WaitGroup
	errs := make([]error, 2)
	results := make([]WriteResult, 2)
	wg.Add(2)
	go func() {
		defer wg.Done()
		results[0], errs[0] = store.Write(context.Background(), Write{CanonicalID: id, Field: CollectionWatchLater, Enabled: true})
	}()
	go func() {
		defer wg.Done()
		results[1], errs[1] = store.Write(context.Background(), Write{CanonicalID: id, Field: CollectionFavourites, Enabled: true})
	}()
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("parallel write %d failed: %v", i, err)
		}
	}
	if results[0].WatchLater != true || results[1].Favourite != true {
		t.Fatalf("one parallel flag write was lost: %+v", results)
	}
	// Each write returns the revision after ITS OWN commit; the writes
	// serialized through the household row, so exactly one revision apart.
	if diff := results[0].Revision - results[1].Revision; diff != 1 && diff != -1 {
		t.Fatalf("serialized revisions not adjacent: %+v", results)
	}
	ctx := context.Background()
	page, err := store.Page(ctx, CollectionWatchLater, KindAll, SortRecent, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	fav, err := store.Page(ctx, CollectionFavourites, KindAll, SortRecent, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 1 || fav.Total != 1 {
		t.Fatalf("independent flags violated: wl=%d fav=%d", page.Total, fav.Total)
	}
}

func TestRollbackDoesNotLeakRevision(t *testing.T) {
	_, store, _ := testDB(t)
	ctx := context.Background()
	before, err := store.Overview(ctx, CollectionWatchLater, SortRecent)
	if err != nil {
		t.Fatal(err)
	}
	store.testHookBeforeCommit = func(tx *sql.Tx) error {
		return errors.New("injected failure before commit")
	}
	defer func() { store.testHookBeforeCommit = nil }()
	if _, err := store.Write(ctx, Write{CanonicalID: "tmdb:movie:693134", Field: CollectionWatchLater, Enabled: true}); err == nil {
		t.Fatal("injected failure did not surface")
	}
	after, err := store.Overview(ctx, CollectionWatchLater, SortRecent)
	if err != nil {
		t.Fatal(err)
	}
	if after.Revision != before.Revision {
		t.Fatalf("failed transaction leaked revision %d -> %d", before.Revision, after.Revision)
	}
	page, err := store.Page(ctx, CollectionWatchLater, KindAll, SortRecent, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 0 {
		t.Fatalf("rolled-back membership persisted: %+v", page.Items)
	}
}

func TestConsistentCountPageOverviewSnapshot(t *testing.T) {
	_, store, _ := testDB(t)
	ctx := context.Background()
	for _, id := range []string{"tmdb:movie:500", "tmdb:movie:42", "tmdb:movie:7"} {
		write(t, store, id, CollectionWatchLater, true)
	}

	secondStore := *store // same DB, used by the hook to write mid-snapshot
	written := false
	store.testHookAfterCount = func() {
		if !written {
			written = true
			_, _ = secondStore.Write(ctx, Write{CanonicalID: "tmdb:movie:11", Field: CollectionWatchLater, Enabled: true})
		}
	}
	defer func() { store.testHookAfterCount = nil }()

	page, err := store.Page(ctx, CollectionWatchLater, KindMovie, SortRecent, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 3 || len(page.Items) != 3 {
		t.Fatalf("snapshot page must reflect the pre-write snapshot: total=%d items=%d", page.Total, len(page.Items))
	}
	if RevisionString(page.Revision) != "3" {
		t.Fatalf("snapshot revision = %q, want the pre-write \"3\"", RevisionString(page.Revision))
	}
	// A fresh read observes the write that committed mid-snapshot.
	fresh, err := store.Page(ctx, CollectionWatchLater, KindMovie, SortRecent, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	if fresh.Total != 4 || fresh.Revision != 4 {
		t.Fatalf("fresh read = total %d revision %d, want 4/4", fresh.Total, fresh.Revision)
	}
}

func TestProcessRestartPersistsState(t *testing.T) {
	base := os.Getenv("TORWATCH_TEST_PG_DSN")
	if base == "" {
		t.Skip("TORWATCH_TEST_PG_DSN not set")
	}
	schema := fmt.Sprintf("libtest_%d_%d", time.Now().UnixNano(), os.Getpid())
	dsn := base + "&search_path=" + schema
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := db.ExecContext(ctx, `CREATE SCHEMA `+schema); err != nil {
		t.Fatal(err)
	}
	if err := migrations.Apply(ctx, db); err != nil {
		t.Fatal(err)
	}
	resolver := &fakeResolver{titles: defaultFakeTitles()}
	store, err := NewStore(ctx, db, resolver)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Write(ctx, Write{CanonicalID: "tmdb:movie:693134", Field: CollectionFavourites, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	// Simulate a process restart: close every pooled connection, reopen, and
	// open a fresh store over the SAME database.
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	restarted, err := NewStore(ctx, reopened, resolver)
	if err != nil {
		t.Fatalf("reopen after restart: %v", err)
	}
	page, err := restarted.Page(ctx, CollectionFavourites, KindAll, SortRecent, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 1 || len(page.Items) != 1 || page.Items[0].CanonicalID != "tmdb:movie:693134" {
		t.Fatalf("restart lost membership: %+v", page)
	}
	if page.Revision != 1 {
		t.Fatalf("restart revision = %d, want 1", page.Revision)
	}
}

func TestSameNumberTMDbMovieAndTVAreIndependent(t *testing.T) {
	_, store, _ := testDB(t)
	ctx := context.Background()
	movie := write(t, store, "tmdb:movie:123", CollectionWatchLater, true)
	series := write(t, store, "tmdb:tv:123", CollectionWatchLater, true)
	if movie.Revision != 1 || series.Revision != 2 {
		t.Fatalf("same-number ids did not create independent memberships: %+v", []WriteResult{movie, series})
	}
	movies, err := store.Page(ctx, CollectionWatchLater, KindMovie, SortRecent, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	seriesPage, err := store.Page(ctx, CollectionWatchLater, KindSeries, SortRecent, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	if movies.Total != 1 || seriesPage.Total != 1 {
		t.Fatalf("kind segregation broken: movie=%d series=%d", movies.Total, seriesPage.Total)
	}
	if movies.Items[0].CanonicalID != "tmdb:movie:123" || seriesPage.Items[0].CanonicalID != "tmdb:tv:123" {
		t.Fatalf("qualified ids collapsed: %+v / %+v", movies.Items, seriesPage.Items)
	}
	// Removing one never removes the other.
	write(t, store, "tmdb:movie:123", CollectionWatchLater, false)
	seriesPage, err = store.Page(ctx, CollectionWatchLater, KindSeries, SortRecent, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	if seriesPage.Total != 1 {
		t.Fatalf("tv membership lost by movie removal: %d", seriesPage.Total)
	}
}

func TestAnimeSegregation(t *testing.T) {
	_, store, _ := testDB(t)
	ctx := context.Background()
	write(t, store, "tmdb:tv:209867", CollectionWatchLater, true) // TMDb anime (classification over tv)
	write(t, store, "anilist:154587", CollectionFavourites, true)
	write(t, store, "tmdb:tv:1396", CollectionWatchLater, true) // plain series

	overview, err := store.Overview(ctx, CollectionWatchLater, SortRecent)
	if err != nil {
		t.Fatal(err)
	}
	counts := map[string]int{}
	for _, shelf := range overview.Shelves {
		counts[shelf.Kind] = shelf.Count
	}
	if counts[KindAnime] != 1 || counts[KindSeries] != 1 || counts[KindMovie] != 0 {
		t.Fatalf("anime duplicated or misfiled: %+v", counts)
	}
	animeOverview, err := store.Overview(ctx, CollectionFavourites, SortRecent)
	if err != nil {
		t.Fatal(err)
	}
	for _, shelf := range animeOverview.Shelves {
		if shelf.Kind == KindAnime && shelf.Count != 1 {
			t.Fatalf("anilist anime not in anime shelf: %+v", shelf)
		}
	}
}

func TestUnavailableMetadataPreservesEntry(t *testing.T) {
	_, store, resolver := testDB(t)
	ctx := context.Background()
	id := "tmdb:movie:99"
	write(t, store, id, CollectionWatchLater, true)
	resolver.remove(id)

	// An effective write while metadata is unavailable must succeed, keep the
	// stored snapshot, and label the entry metadata-unavailable.
	result := write(t, store, id, CollectionFavourites, true)
	if !result.Favourite {
		t.Fatalf("write with unavailable metadata lost the flag: %+v", result)
	}
	page, err := store.Page(ctx, CollectionWatchLater, KindAll, SortRecent, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("metadata-unavailable entry vanished: %+v", page.Items)
	}
	item := page.Items[0]
	if item.MetadataAvailable {
		t.Fatalf("entry must be labelled metadata-unavailable: %+v", item)
	}
	if item.Title != "Vanishing" {
		t.Fatalf("snapshot title not preserved: %+v", item)
	}
	// The entry stays removable.
	write(t, store, id, CollectionWatchLater, false)
	page, err = store.Page(ctx, CollectionWatchLater, KindAll, SortRecent, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 0 {
		t.Fatalf("metadata-unavailable entry not removable: %+v", page.Items)
	}
}

func TestUnknownTitleIsNotFound(t *testing.T) {
	_, store, resolver := testDB(t)
	resolver.remove("tmdb:movie:99")
	_, err := store.Write(context.Background(), Write{CanonicalID: "tmdb:movie:99", Field: CollectionWatchLater, Enabled: true})
	if !errors.Is(err, ErrTitleNotFound) {
		t.Fatalf("unknown title = %v, want ErrTitleNotFound", err)
	}
}

func TestPaginationBeyondOnePage(t *testing.T) {
	_, store, _ := testDB(t)
	ctx := context.Background()
	ids := []string{"tmdb:movie:500", "tmdb:movie:42", "tmdb:movie:7", "tmdb:movie:11", "tmdb:movie:693134"}
	for _, id := range ids {
		write(t, store, id, CollectionWatchLater, true)
	}

	seen := map[string]bool{}
	cursor := ""
	pages := 0
	for {
		page, err := store.Page(ctx, CollectionWatchLater, KindMovie, SortRecent, cursor, 2)
		if err != nil {
			t.Fatal(err)
		}
		if page.Total != 5 {
			t.Fatalf("full-scope total = %d, want 5 on every page", page.Total)
		}
		if len(page.Items) > 2 {
			t.Fatalf("limit not honored: %d items", len(page.Items))
		}
		for _, item := range page.Items {
			if seen[item.CanonicalID] {
				t.Fatalf("duplicate %s across pages", item.CanonicalID)
			}
			seen[item.CanonicalID] = true
		}
		pages++
		if page.NextCursor == "" {
			break
		}
		cursor = page.NextCursor
		if pages > 10 {
			t.Fatal("pagination did not terminate")
		}
	}
	if pages != 3 || len(seen) != 5 {
		t.Fatalf("pages=%d seen=%d, want 3 pages over 5 entries", pages, len(seen))
	}
}

func TestCursorScopeMismatchRejected(t *testing.T) {
	_, store, _ := testDB(t)
	ctx := context.Background()
	write(t, store, "tmdb:movie:500", CollectionWatchLater, true)
	write(t, store, "tmdb:movie:42", CollectionWatchLater, true)

	page, err := store.Page(ctx, CollectionWatchLater, KindMovie, SortRecent, "", 1)
	if err != nil {
		t.Fatal(err)
	}
	if page.NextCursor == "" {
		t.Fatal("expected a next cursor")
	}
	// Same scope: accepted.
	if _, err := store.Page(ctx, CollectionWatchLater, KindMovie, SortRecent, page.NextCursor, 1); err != nil {
		t.Fatalf("scope-matched cursor rejected: %v", err)
	}
	// Kind mismatch: rejected, never silently mixed.
	if _, err := store.Page(ctx, CollectionWatchLater, KindAll, SortRecent, page.NextCursor, 1); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("kind-mismatched cursor = %v, want ErrInvalidRequest", err)
	}
	// Sort mismatch: rejected.
	if _, err := store.Page(ctx, CollectionWatchLater, KindMovie, SortTitle, page.NextCursor, 1); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("sort-mismatched cursor = %v, want ErrInvalidRequest", err)
	}
	// Collection mismatch: rejected.
	if _, err := store.Page(ctx, CollectionFavourites, KindMovie, SortRecent, page.NextCursor, 1); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("collection-mismatched cursor = %v, want ErrInvalidRequest", err)
	}
	// Garbage cursor: rejected.
	if _, err := store.Page(ctx, CollectionWatchLater, KindMovie, SortRecent, "not-a-cursor", 1); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("garbage cursor = %v, want ErrInvalidRequest", err)
	}
}

func TestSortOrdersAndSwitch(t *testing.T) {
	_, store, _ := testDB(t)
	ctx := context.Background()
	// Insert order: Zulu, Alpha, mIxEd Case (recent order = reverse insert).
	write(t, store, "tmdb:movie:7", CollectionWatchLater, true)
	time.Sleep(2 * time.Millisecond)
	write(t, store, "tmdb:movie:42", CollectionWatchLater, true)
	time.Sleep(2 * time.Millisecond)
	write(t, store, "tmdb:movie:11", CollectionWatchLater, true)

	recent, err := store.Page(ctx, CollectionWatchLater, KindMovie, SortRecent, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	if recent.Items[0].CanonicalID != "tmdb:movie:11" || recent.Items[2].CanonicalID != "tmdb:movie:7" {
		t.Fatalf("recent order wrong: %+v", recent.Items)
	}
	title, err := store.Page(ctx, CollectionWatchLater, KindMovie, SortTitle, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	if title.Items[0].Title != "Alpha" || title.Items[1].Title != "mIxEd Case" || title.Items[2].Title != "Zulu" {
		t.Fatalf("title order wrong: %+v", title.Items)
	}
	// A recent cursor cannot straddle into a title-ordered page (covered
	// exhaustively in TestCursorScopeMismatchRejected).
}

func TestRevisionBeyondSafeIntegerStaysLossless(t *testing.T) {
	db, store, _ := testDB(t)
	ctx := context.Background()
	// Seed the household revision beyond Number.MAX_SAFE_INTEGER (2^53-1).
	const huge = int64(9007199254740993)
	if _, err := db.ExecContext(ctx, `UPDATE library_household SET revision=$1 WHERE id=1`, huge); err != nil {
		t.Fatal(err)
	}
	result := write(t, store, "tmdb:movie:693134", CollectionWatchLater, true)
	if RevisionString(result.Revision) != strconv.FormatInt(huge+1, 10) {
		t.Fatalf("revision = %q, want exact decimal %q", RevisionString(result.Revision), strconv.FormatInt(huge+1, 10))
	}
	page, err := store.Page(ctx, CollectionWatchLater, KindAll, SortRecent, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	if RevisionString(page.Revision) != strconv.FormatInt(huge+1, 10) {
		t.Fatalf("page revision = %q", RevisionString(page.Revision))
	}
}

func TestReadsNeverCallResolver(t *testing.T) {
	_, store, resolver := testDB(t)
	ctx := context.Background()
	write(t, store, "tmdb:movie:693134", CollectionWatchLater, true)
	write(t, store, "tmdb:tv:1396", CollectionWatchLater, true)
	before := resolver.callCount()
	for range 5 {
		if _, err := store.Page(ctx, CollectionWatchLater, KindAll, SortRecent, "", 0); err != nil {
			t.Fatal(err)
		}
		if _, err := store.Overview(ctx, CollectionWatchLater, SortRecent); err != nil {
			t.Fatal(err)
		}
	}
	if after := resolver.callCount(); after != before {
		t.Fatalf("reads called the resolver %d times (N+1 provider fan-out)", after-before)
	}
}

func TestNewStoreRequiresInitializedSchema(t *testing.T) {
	base := os.Getenv("TORWATCH_TEST_PG_DSN")
	if base == "" {
		t.Skip("TORWATCH_TEST_PG_DSN not set")
	}
	schema := fmt.Sprintf("libtest_%d_%d", time.Now().UnixNano(), os.Getpid())
	dsn := base + "&search_path=" + schema
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	if _, err := db.ExecContext(ctx, `CREATE SCHEMA `+schema); err != nil {
		t.Fatal(err)
	}
	// No migrations applied: the library storage is not initialized, so the
	// store must refuse to open (and the capability must not be advertised).
	if _, err := NewStore(ctx, db, nil); err == nil {
		t.Fatal("store opened without an initialized schema; capability gating broken")
	}
}

func TestUnqualifiedAliasAndMalformedIDsRejected(t *testing.T) {
	_, store, _ := testDB(t)
	for _, id := range []string{
		"tmdb:123",       // legacy unqualified alias — never a library key
		"tmdb:movie:abc", // non-numeric
		"tmdb:tv:",       // empty external id
		"bogus",          // not namespaced
		"tmdb:anime:123", // anime is a classification, not an id namespace
	} {
		if _, err := store.Write(context.Background(), Write{CanonicalID: id, Field: CollectionWatchLater, Enabled: true}); !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("id %q = %v, want ErrInvalidRequest", id, err)
		}
	}
	if err := ValidateCanonicalID("anilist:154587"); err != nil {
		t.Fatalf("anilist id rejected: %v", err)
	}
	if err := ValidateCanonicalID("jikan:52991"); err != nil {
		t.Fatalf("jikan id rejected: %v", err)
	}
}
