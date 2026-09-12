package recommendations

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib" // database/sql driver

	"torrent-streamer/internal/catalog"
	"torrent-streamer/internal/library"
	"torrent-streamer/migrations"
)

// DB-backed integration: the recommendation service over the REAL library
// store on a disposable PostgreSQL (isolated schema per test).
func testLibraryDB(t *testing.T) (*sql.DB, *library.Store) {
	t.Helper()
	base := os.Getenv("TORWATCH_TEST_PG_DSN")
	if base == "" {
		t.Skip("TORWATCH_TEST_PG_DSN not set; recommendation-library integration pending a disposable database")
	}
	schema := fmt.Sprintf("rec_%d_%d", time.Now().UnixNano(), os.Getpid())
	dsn := base + "&search_path=" + schema
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatalf("open test schema: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	ctx := context.Background()
	if _, err := db.ExecContext(ctx, `CREATE SCHEMA `+schema); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	if err := migrations.Apply(ctx, db); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	resolver := &recFakeResolver{titles: map[string]library.Metadata{
		"tmdb:movie:1": {Title: "Seed Movie", Kind: "movie", SortKey: "seed movie"},
		"tmdb:movie:2": {Title: "Watch Later Movie", Kind: "movie", SortKey: "watch later movie"},
		"tmdb:movie:3": {Title: "Unrelated", Kind: "movie", SortKey: "unrelated"},
	}}
	store, err := library.NewStore(ctx, db, resolver)
	if err != nil {
		t.Fatalf("open library store: %v", err)
	}
	return db, store
}

type recFakeResolver struct{ titles map[string]library.Metadata }

func (f *recFakeResolver) Resolve(_ context.Context, canonicalID string) (library.Metadata, error) {
	meta, ok := f.titles[canonicalID]
	if !ok {
		return library.Metadata{}, catalog.ErrNotFound
	}
	return meta, nil
}

func writeFlag(t *testing.T, store *library.Store, id string, field string, enabled bool) {
	t.Helper()
	if _, err := store.Write(context.Background(), library.Write{CanonicalID: id, Field: field, Enabled: enabled}); err != nil {
		t.Fatalf("write %s %s: %v", id, field, err)
	}
}

func TestRecommendationsAgainstRealLibraryStore(t *testing.T) {
	_, store := testLibraryDB(t)
	ctx := context.Background()

	// A favourite seed with genres, a watch-later title to exclude.
	writeFlag(t, store, "tmdb:movie:1", library.CollectionFavourites, true)
	writeFlag(t, store, "tmdb:movie:2", library.CollectionWatchLater, true)

	seedGenres := &fakeSeedGenres{genres: map[string][]string{"tmdb:movie:1": {"Action"}}}
	candidates := &fakeCandidates{titles: []catalog.Title{
		tmdbMovie(9, "Scores", "Action"),
		tmdbMovie(1, "Seed Movie"),  // favourite → excluded
		tmdbMovie(2, "Watch Later"), // watch-later → excluded
		tmdbMovie(3, "Unrelated", "Romance"),
	}}
	service := newTestService(store, candidates, seedGenres, 1)
	result, err := service.Recommend(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Items) != 2 {
		t.Fatalf("items = %+v", result.Items)
	}
	if result.Items[0].CanonicalID != "tmdb:movie:9" || result.Items[0].Reason.Code != reasonSeedGenre {
		t.Fatalf("scored item wrong: %+v", result.Items[0])
	}
	if result.Items[1].CanonicalID != "tmdb:movie:3" {
		t.Fatalf("second item wrong: %+v", result.Items[1])
	}

	// Effective mutation → revision advances → cache invalidates (rebuild).
	callsBefore := candidates.calls
	writeFlag(t, store, "tmdb:movie:3", library.CollectionFavourites, true)
	result, err = service.Recommend(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if candidates.calls != callsBefore+1 {
		t.Fatalf("effective mutation must invalidate the cache: builds %d → %d", callsBefore, candidates.calls)
	}
	// The newly favourited title is excluded after the rebuild.
	for _, item := range result.Items {
		if item.CanonicalID == "tmdb:movie:3" {
			t.Fatalf("newly favourited title must be excluded: %+v", result.Items)
		}
	}

	// No-op write → same revision → cached result served (no rebuild).
	callsBefore = candidates.calls
	writeFlag(t, store, "tmdb:movie:3", library.CollectionFavourites, true)
	if _, err := service.Recommend(ctx); err != nil {
		t.Fatal(err)
	}
	if candidates.calls != callsBefore {
		t.Fatalf("no-op write must NOT invalidate: builds %d → %d", callsBefore, candidates.calls)
	}

	// Restart behavior: a fresh service instance (in-memory cache lost)
	// recomputes on demand and agrees with the library.
	fresh := newTestService(store, candidates, seedGenres, 1)
	rebuilt, err := fresh.Recommend(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range rebuilt.Items {
		if item.CanonicalID == "tmdb:movie:3" {
			t.Fatalf("restarted service must honor exclusions: %+v", rebuilt.Items)
		}
	}
}
