package stremiosync

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// Account is a profile's linked Stremio account (migrations/018). The
// session key never leaves the server.
type Account struct {
	ProfileID  string     `json:"-"`
	Email      string     `json:"email"`
	AuthKey    string     `json:"-"`
	LinkedAt   time.Time  `json:"linkedAt"`
	LastSyncAt *time.Time `json:"lastSyncAt"`
	LastError  string     `json:"lastError"`
	Imported   int        `json:"imported"`
}

type Store struct{ DB *sql.DB }

const accountColumns = `profile_id, email, auth_key, linked_at, last_sync_at, last_error, imported`

func scanAccount(row interface{ Scan(...any) error }) (Account, error) {
	var a Account
	var last sql.NullTime
	if err := row.Scan(&a.ProfileID, &a.Email, &a.AuthKey, &a.LinkedAt, &last, &a.LastError, &a.Imported); err != nil {
		return Account{}, err
	}
	if last.Valid {
		at := last.Time
		a.LastSyncAt = &at
	}
	return a, nil
}

// Get returns the profile's account (ok false when none is linked).
func (s *Store) Get(ctx context.Context, profileID string) (Account, bool, error) {
	a, err := scanAccount(s.DB.QueryRowContext(ctx, `SELECT `+accountColumns+` FROM stremio_accounts WHERE profile_id=$1`, profileID))
	if errors.Is(err, sql.ErrNoRows) {
		return Account{}, false, nil
	}
	return a, err == nil, err
}

func (s *Store) List(ctx context.Context) ([]Account, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT `+accountColumns+` FROM stremio_accounts ORDER BY profile_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Account
	for rows.Next() {
		a, err := scanAccount(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// Link stores (or replaces) the profile's account.
func (s *Store) Link(ctx context.Context, profileID, email, authKey string) error {
	_, err := s.DB.ExecContext(ctx, `
INSERT INTO stremio_accounts (profile_id, email, auth_key) VALUES ($1,$2,$3)
ON CONFLICT (profile_id) DO UPDATE SET email=EXCLUDED.email, auth_key=EXCLUDED.auth_key,
  linked_at=now(), last_sync_at=NULL, last_error='', imported=0`, profileID, email, authKey)
	return err
}

// Unlink forgets the profile's account (what it imported stays).
func (s *Store) Unlink(ctx context.Context, profileID string) error {
	_, err := s.DB.ExecContext(ctx, `DELETE FROM stremio_accounts WHERE profile_id=$1`, profileID)
	return err
}

// Record notes a sync: how many positions it applied and its error ("" ok).
func (s *Store) Record(ctx context.Context, profileID string, applied int, syncErr string) error {
	_, err := s.DB.ExecContext(ctx, `
UPDATE stremio_accounts SET last_sync_at=now(), last_error=$2, imported=imported+$3 WHERE profile_id=$1`,
		profileID, syncErr, applied)
	return err
}
