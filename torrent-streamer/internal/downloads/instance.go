package downloads

import (
	"context"
	"database/sql"
	"fmt"
)

// EnsureInstanceID returns the persistent server-instance identity
// (contracts.md §1). The singleton row is created once by migration
// 009 (or, for databases migrated before this helper existed, lazily here
// with the same ON CONFLICT protection); every later call — and every
// restart — observes the SAME id. Instance identity is stable across URL
// changes and changes across reinstalls, which is exactly the scoping
// contract offline progress depends on.
func EnsureInstanceID(ctx context.Context, db *sql.DB) (string, error) {
	var id string
	err := db.QueryRowContext(ctx, `SELECT id FROM server_instance`).Scan(&id)
	switch {
	case err == nil:
		if id == "" {
			return "", fmt.Errorf("server_instance row has an empty id")
		}
		return id, nil
	case err != sql.ErrNoRows:
		return "", fmt.Errorf("read server instance identity: %w", err)
	}
	// Singleton row missing (should not happen post-migration): create it
	// race-safely. gen_random_uuid() is built into PostgreSQL 13+.
	if _, err := db.ExecContext(ctx, `
INSERT INTO server_instance (singleton, id)
VALUES (TRUE, gen_random_uuid())
ON CONFLICT (singleton) DO NOTHING`); err != nil {
		return "", fmt.Errorf("create server instance identity: %w", err)
	}
	if err := db.QueryRowContext(ctx, `SELECT id FROM server_instance`).Scan(&id); err != nil {
		return "", fmt.Errorf("read server instance identity after create: %w", err)
	}
	return id, nil
}
