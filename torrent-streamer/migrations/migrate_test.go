package migrations

import (
	"context"
	"database/sql"
	"os"
	"testing"
	"testing/fstest"

	_ "github.com/jackc/pgx/v5/stdlib" // database/sql driver
)

// TestMigration005Additive applies the full embedded set to a disposable
// PostgreSQL database and verifies the 005 expansion: new columns exist with
// safe defaults, old columns are untouched, and a simulated pre-005 row
// (written before the new columns existed) remains readable and updatable —
// the backward-compatibility guarantee of the expand phase. Skipped (pending,
// never passed) when no disposable database is provided.
func TestMigration005Additive(t *testing.T) {
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
		t.Fatalf("configured test database failed: %v", err)
	}

	var columnNames []string
	rows, err := db.QueryContext(ctx, `
SELECT column_name FROM information_schema.columns
WHERE table_name='watch_progress' ORDER BY column_name`)
	if err != nil {
		t.Fatalf("inspect watch_progress: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatalf("scan column: %v", err)
		}
		columnNames = append(columnNames, name)
	}
	for _, expected := range []string{
		"subject_id", "series_id", "season", "episode", "position_s", "duration_s", "percent",
		"source_uri", "source_name", "source_kind", "source_file_index", "created_at", "updated_at", "id",
		"progress_revision", "writer_client_id", "stream_session_id", "last_seq",
	} {
		found := false
		for _, name := range columnNames {
			if name == expected {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("watch_progress missing column %q after migration 005: %v", expected, columnNames)
		}
	}

	// Pre-005 style write (new columns omitted) must succeed and get revision 1.
	if _, err := db.ExecContext(ctx, `
INSERT INTO watch_progress (subject_id, series_id, season, episode, position_s, duration_s, percent, created_at, updated_at)
VALUES ('mig-subject','mig-series',1,1,300,1440,20.8,now(),now())
ON CONFLICT (subject_id, series_id, season, episode) DO UPDATE SET updated_at=now()`); err != nil {
		t.Fatalf("pre-005 style insert: %v", err)
	}
	var revision int64
	if err := db.QueryRowContext(ctx,
		`SELECT progress_revision FROM watch_progress WHERE subject_id='mig-subject' AND series_id='mig-series'`,
	).Scan(&revision); err != nil {
		t.Fatalf("read progress_revision: %v", err)
	}
	if revision < 1 {
		t.Fatalf("progress_revision default/backfill = %d, want >= 1", revision)
	}
}

func TestMigration006PreservesKnownSessionSequence(t *testing.T) {
	dsn := os.Getenv("TORWATCH_TEST_PG_DSN")
	if dsn == "" {
		t.Skip("TORWATCH_TEST_PG_DSN not set")
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	// An isolated, rolled-back schema exercises upgrade from 005 without
	// changing tables used by other integration tests.
	if _, err := tx.ExecContext(ctx, `CREATE SCHEMA migration006_test; SET LOCAL search_path TO migration006_test`); err != nil {
		t.Fatal(err)
	}
	entries, err := files.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.Name() >= "006_progress_session_sequences.sql" {
			continue
		}
		data, err := files.ReadFile(entry.Name())
		if err != nil {
			t.Fatal(err)
		}
		if _, err := tx.ExecContext(ctx, string(data)); err != nil {
			t.Fatalf("apply %s: %v", entry.Name(), err)
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO watch_progress
(subject_id, series_id, season, episode, position_s, duration_s, percent, stream_session_id, last_seq, progress_revision)
VALUES ('upgrade', 'title', 1, 1, 300, 1000, 30, 'session-a', 10, 4)`); err != nil {
		t.Fatal(err)
	}
	data, err := files.ReadFile("006_progress_session_sequences.sql")
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if _, err := tx.ExecContext(ctx, string(data)); err != nil {
			t.Fatalf("apply 006: %v", err)
		}
	}
	var seq, position, revision int
	if err := tx.QueryRowContext(ctx, `SELECT s.last_seq, wp.position_s, wp.progress_revision
FROM watch_progress wp JOIN watch_progress_sessions s ON s.progress_id=wp.id
WHERE s.session_id='session-a'`).Scan(&seq, &position, &revision); err != nil {
		t.Fatal(err)
	}
	if seq != 10 || position != 300 || revision != 4 {
		t.Fatalf("upgrade changed checkpoint: seq=%d position=%d revision=%d", seq, position, revision)
	}
}

// TestMigrationFilesAreWellFormed statically guards the embedded set: names
// stay sortable (ordering contract) and 005 contains no destructive
// statements (DROP/RENAME/TRUNCATE) — expand-phase discipline.
func TestMigrationFilesAreWellFormed(t *testing.T) {
	entries, err := files.ReadDir(".")
	if err != nil {
		t.Fatalf("read embedded migrations: %v", err)
	}
	previous := ""
	found005 := false
	for _, entry := range entries {
		name := entry.Name()
		if previous != "" && name <= previous {
			t.Fatalf("migration %s breaks filename ordering (after %s)", name, previous)
		}
		previous = name
		if name == "005_progress_multiclient.sql" {
			found005 = true
			data, err := files.ReadFile(name)
			if err != nil {
				t.Fatalf("read 005: %v", err)
			}
			content := stripSQLComments(string(data))
			for _, banned := range []string{"DROP TABLE", "DROP COLUMN", "RENAME", "TRUNCATE", "DELETE FROM"} {
				if containsFold(content, banned) {
					t.Fatalf("expand migration 005 must not contain %q", banned)
				}
			}
		}
	}
	if !found005 {
		t.Fatal("005_progress_multiclient.sql missing from embedded migrations")
	}
}

// TestEmbedIntegrity keeps the embedded FS honest for static analysis.
func TestEmbedIntegrity(t *testing.T) {
	if err := fstest.TestFS(files, "001_core.sql", "005_progress_multiclient.sql"); err != nil {
		t.Fatalf("embedded migration FS invalid: %v", err)
	}
}

// stripSQLComments removes -- comment lines so banned-statement scanning
// does not trip on prose.
func stripSQLComments(content string) string {
	var kept []string
	for _, line := range splitLines(content) {
		if !containsFold(line, "--") {
			kept = append(kept, line)
		}
	}
	return joinLines(kept)
}

func splitLines(content string) []string {
	var lines []string
	start := 0
	for i := 0; i < len(content); i++ {
		if content[i] == '\n' {
			lines = append(lines, content[start:i])
			start = i + 1
		}
	}
	return append(lines, content[start:])
}

func joinLines(lines []string) string {
	out := ""
	for _, line := range lines {
		out += line + "\n"
	}
	return out
}

func containsFold(haystack, needle string) bool {
	lower := []rune(haystack)
	needleLower := []rune(needle)
	for i := 0; i+len(needleLower) <= len(lower); i++ {
		match := true
		for j := range needleLower {
			a := lower[i+j]
			b := needleLower[j]
			if a >= 'A' && a <= 'Z' {
				a += 32
			}
			if b >= 'A' && b <= 'Z' {
				b += 32
			}
			if a != b {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}
