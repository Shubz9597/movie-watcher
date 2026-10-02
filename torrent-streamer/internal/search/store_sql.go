package search

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// SQLReleaseStore keeps raw releases in the search_cache table.
type SQLReleaseStore struct{ DB *sql.DB }

func (s SQLReleaseStore) LoadReleases(ctx context.Context, key string) ([]byte, time.Time, bool, error) {
	var payload []byte
	var fetchedAt time.Time
	err := s.DB.QueryRowContext(ctx, `SELECT candidates, fetched_at FROM search_cache WHERE key = $1`, key).Scan(&payload, &fetchedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, time.Time{}, false, nil
	}
	if err != nil {
		return nil, time.Time{}, false, err
	}
	return payload, fetchedAt, true, nil
}

func (s SQLReleaseStore) SaveReleases(ctx context.Context, key string, payload []byte) error {
	_, err := s.DB.ExecContext(ctx, `
INSERT INTO search_cache (key, candidates, fetched_at) VALUES ($1, $2::jsonb, now())
ON CONFLICT (key) DO UPDATE SET candidates = EXCLUDED.candidates, fetched_at = EXCLUDED.fetched_at`, key, string(payload))
	return err
}
