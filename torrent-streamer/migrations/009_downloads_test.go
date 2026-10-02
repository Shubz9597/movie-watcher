package migrations

import (
	"context"
	"database/sql"
	"os"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib" // database/sql driver
)

// TestMigration009DownloadsAdditive applies the full embedded set to a
// disposable PostgreSQL database and verifies the 009 expansion for the
// offline-downloads contracts: the new tables exist, the singleton instance
// identity is created once and stays stable across a re-run (restart
// safety), and the state/reason CHECK constraints accept the contracted
// pairs and reject foreign ones. Skipped (pending, never passed) when no
// disposable database is provided.
func TestMigration009DownloadsAdditive(t *testing.T) {
	dsn := os.Getenv("TORWATCH_TEST_PG_DSN")
	if dsn == "" {
		t.Skip("TORWATCH_TEST_PG_DSN not set; migration verification pending a disposable database")
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatalf("configured test database failed: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	ctx := context.Background()
	if err := Apply(ctx, db); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}

	// Singleton identity: stable across a second apply (restart safety).
	var first string
	if err := db.QueryRowContext(ctx, `SELECT id FROM server_instance`).Scan(&first); err != nil {
		t.Fatalf("read instance identity: %v", err)
	}
	if err := Apply(ctx, db); err != nil {
		t.Fatalf("re-apply migrations: %v", err)
	}
	var second string
	if err := db.QueryRowContext(ctx, `SELECT id FROM server_instance`).Scan(&second); err != nil {
		t.Fatalf("re-read instance identity: %v", err)
	}
	if first != second {
		t.Fatalf("instance identity changed across re-apply: %s -> %s", first, second)
	}

	// A contracted (state, reason) pair is accepted.
	if _, err := db.ExecContext(ctx, `
INSERT INTO download_jobs (idempotency_key, client_id, series_id, pick_id, state, reason_code)
VALUES ('test-key-1', 'test-client', 'tmdb:movie:1', 1, 'failed', 'source_unavailable')`); err != nil {
		t.Fatalf("insert contracted failed job: %v", err)
	}
	// 010: subtitles_unavailable joins the failed reasons; subtitle hints
	// default to an empty object.
	if _, err := db.ExecContext(ctx, `
INSERT INTO download_jobs (idempotency_key, client_id, series_id, pick_id, state, reason_code)
VALUES ('test-key-3', 'test-client', 'tmdb:movie:1', 1, 'failed', 'subtitles_unavailable')`); err != nil {
		t.Fatalf("insert failed/subtitles_unavailable job: %v", err)
	}
	var hints string
	if err := db.QueryRowContext(ctx, `SELECT subtitle_hints::text FROM download_jobs WHERE idempotency_key='test-key-3'`).Scan(&hints); err != nil || hints != "{}" {
		t.Fatalf("subtitle_hints default = %q err=%v, want {}", hints, err)
	}
	if _, err := db.ExecContext(ctx, `
INSERT INTO download_jobs (idempotency_key, client_id, series_id, pick_id, state, reason_code)
VALUES ('test-key-4', 'test-client', 'tmdb:movie:1', 1, 'ready', 'subtitles_unavailable')`); err == nil {
		t.Fatalf("ready/subtitles_unavailable was accepted")
	}
	// A foreign reason code is rejected by the CHECK constraint.
	if _, err := db.ExecContext(ctx, `
INSERT INTO download_jobs (idempotency_key, client_id, series_id, pick_id, state, reason_code)
VALUES ('test-key-2', 'test-client', 'tmdb:movie:1', 1, 'failed', 'internal_stack_trace')`); err == nil {
		t.Fatalf("foreign reason code was accepted; the contract CHECK is missing")
	}
	// Duplicate idempotency keys for the same client are rejected by the
	// UNIQUE constraint (the handler relies on this for idempotent replay).
	if _, err := db.ExecContext(ctx, `
INSERT INTO download_jobs (idempotency_key, client_id, series_id, pick_id, state)
VALUES ('test-key-1', 'test-client', 'tmdb:movie:1', 1, 'preparing')`); err == nil {
		t.Fatalf("duplicate idempotency key was accepted")
	}
}
