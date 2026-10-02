package search

import (
	"context"
	"database/sql"
	"os"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"
)

func TestSQLReleaseStoreRoundTrip(t *testing.T) {
	dsn := os.Getenv("TORWATCH_TEST_PG_DSN")
	if dsn == "" {
		t.Skip("TORWATCH_TEST_PG_DSN not set")
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	store := SQLReleaseStore{DB: db}
	ctx := context.Background()
	key := "test|" + t.Name()

	if _, _, ok, err := store.LoadReleases(ctx, key); err != nil || ok {
		t.Fatalf("empty load = %t, %v; want a miss", ok, err)
	}
	for _, payload := range []string{`[{"title":"a"}]`, `[{"title":"b"}]`} {
		if err := store.SaveReleases(ctx, key, []byte(payload)); err != nil {
			t.Fatalf("save: %v", err)
		}
	}
	payload, fetchedAt, ok, err := store.LoadReleases(ctx, key)
	if err != nil || !ok || fetchedAt.IsZero() || string(payload) != `[{"title": "b"}]` {
		t.Fatalf("load = %s, %v, %t, %v; want the latest payload", payload, fetchedAt, ok, err)
	}
}
