package downloads

import (
	"context"
	"database/sql"
	"os"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib" // database/sql driver
)

// TestEnsureInstanceIDStable verifies the §1 contract against a disposable
// database: the identity exists, is a non-empty UUID-shaped string, and is
// STABLE across repeated calls (restart safety). Skipped (pending, never
// passed) when no disposable database is provided.
func TestEnsureInstanceIDStable(t *testing.T) {
	dsn := os.Getenv("TORWATCH_TEST_PG_DSN")
	if dsn == "" {
		t.Skip("TORWATCH_TEST_PG_DSN not set; instance-identity verification pending a disposable database")
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatalf("configured test database failed: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	ctx := context.Background()

	first, err := EnsureInstanceID(ctx, db)
	if err != nil {
		t.Fatalf("first EnsureInstanceID: %v", err)
	}
	if len(first) != 36 || first[8] != '-' {
		t.Fatalf("instance identity must be a UUID, got %q", first)
	}
	second, err := EnsureInstanceID(ctx, db)
	if err != nil {
		t.Fatalf("second EnsureInstanceID: %v", err)
	}
	if first != second {
		t.Fatalf("instance identity changed across calls: %s -> %s", first, second)
	}
}
