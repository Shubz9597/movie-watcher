package watch

import (
	"context"
	"database/sql"

	_ "github.com/jackc/pgx/v5/stdlib" // database/sql driver

	"torrent-streamer/migrations"
)

// NewTestStore opens a store against a disposable database and applies all
// embedded migrations (including session sequence history). Used only by tests that provide
// TORWATCH_TEST_PG_DSN.
func NewTestStore(ctx context.Context, dsn string) (*Store, error) {
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, err
	}
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	if err := migrations.Apply(ctx, db); err != nil {
		_ = db.Close()
		return nil, err
	}
	return &Store{DB: db}, nil
}

// Close releases the underlying database pool.
func (s *Store) Close() error { return s.DB.Close() }
