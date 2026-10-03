package migrations

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

func TestConcurrentApply(t *testing.T) {
	t.Run("empty", func(t *testing.T) { testConcurrentApply(t, false) })
	t.Run("upgrading", func(t *testing.T) { testConcurrentApply(t, true) })
}

func testConcurrentApply(t *testing.T, upgrading bool) {
	t.Helper()
	dsn := os.Getenv("TORWATCH_TEST_PG_DSN")
	if dsn == "" {
		t.Skip("TORWATCH_TEST_PG_DSN not set")
	}
	admin, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	schema := fmt.Sprintf("migration_concurrent_%d", time.Now().UnixNano())
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.ExecContext(ctx, "CREATE SCHEMA "+quoted); err != nil {
		t.Fatal(err)
	}
	defer admin.ExecContext(context.Background(), "DROP SCHEMA "+quoted+" CASCADE")
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	cfg.RuntimeParams["search_path"] = schema
	db := sql.OpenDB(stdlib.GetConnector(*cfg))
	defer db.Close()
	if upgrading {
		if err := Apply(ctx, db); err != nil {
			t.Fatal(err)
		}
		// This schema is disposable and isolated. Restore the pre-011 layout
		// and preserve a legacy row before concurrent upgrade attempts.
		if _, err := db.ExecContext(ctx, `ALTER TABLE download_jobs DROP COLUMN cleanup_completed_at;
DELETE FROM schema_migrations WHERE version='011_download_cleanup.sql';
INSERT INTO download_jobs(client_id,idempotency_key,series_id,pick_id,state)
VALUES('legacy','legacy','tmdb:movie:1',1,'preparing')`); err != nil {
			t.Fatal(err)
		}
	}
	var wg sync.WaitGroup
	start := make(chan struct{})
	errs := make(chan error, 8)
	for range 8 {
		wg.Add(1)
		go func() { defer wg.Done(); <-start; errs <- Apply(ctx, db) }()
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Error(err)
		}
	}
	entries, err := files.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	want := 0
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".sql") {
			want++
		}
	}
	var count int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM schema_migrations`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != want {
		t.Fatalf("ledger contains %d migrations, want %d", count, want)
	}
	if upgrading {
		var state string
		if err := db.QueryRowContext(ctx, `SELECT state FROM download_jobs WHERE client_id='legacy'`).Scan(&state); err != nil {
			t.Fatal(err)
		}
		if state != "preparing" {
			t.Fatal("upgrade changed a legacy job")
		}
	}
}
