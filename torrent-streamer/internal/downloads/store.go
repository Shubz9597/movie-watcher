package downloads

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// Service is the storage contract the D02 HTTP handlers consume. The SQL
// Store implements it; contract tests may substitute a scripted fake. All
// job access is scoped by the owning client id (contracts.md §3).
type Service interface {
	// Create inserts a preparation job; when the (clientID, idempotencyKey)
	// pair already exists it returns the EXISTING job with created=false
	// (idempotent replay). Validation errors return ErrInvalidSource.
	Create(ctx context.Context, req CreateRequest) (job Job, created bool, err error)
	Get(ctx context.Context, clientID, jobID string) (Job, error)
	Cancel(ctx context.Context, clientID, jobID string) (Job, error)
	Renew(ctx context.Context, clientID, jobID string, now time.Time) (Job, error)
	// Manifest returns the validated ready-package manifest of a ready job.
	Manifest(ctx context.Context, clientID, jobID string) (Manifest, error)
	// MarkReady drives the worker-side transition preparing -> ready with the
	// complete manifest (retention clock starts here).
	MarkReady(ctx context.Context, jobID string, manifest Manifest, now time.Time) error
	// ExpireDue flips ready jobs whose expiry has passed to expired
	// (retention_expired) and returns their ids for bounded asset cleanup.
	ExpireDue(ctx context.Context, now time.Time, limit int) ([]string, error)
}

// Sentinel errors mapped to safe HTTP responses by the handlers.
var (
	ErrNotFound         = errors.New("download job not found")
	ErrNotCancellable   = errors.New("job is not cancellable in its current state")
	ErrExpired          = errors.New("job retention has expired")
	ErrInvalidSource    = errors.New("invalid source identity")
	ErrInvalidRequest   = errors.New("invalid request")
	ErrNotReady         = errors.New("job is not ready")
)

// CreateRequest is the validated payload of POST /v1/downloads/jobs
// (contracts.md §3). Identity fields are opaque server references.
type CreateRequest struct {
	ClientID       string
	IdempotencyKey string
	SeriesID       string
	Season         int
	Episode        int
	PickID         int64
}

// Job is the durable preparation job as exposed to clients and workers.
type Job struct {
	ID             string
	IdempotencyKey string
	ClientID       string
	SeriesID       string
	Season         int
	Episode        int
	PickID         int64
	State          string
	ReasonCode     string
	ReadyAt        *time.Time
	ExpiresAt      *time.Time
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

// Store is the PostgreSQL-backed Service.
type Store struct {
	DB *sql.DB
}

func NewStore(db *sql.DB) *Store { return &Store{DB: db} }

const jobColumns = `id, idempotency_key, client_id, series_id, season, episode, pick_id,
state, reason_code, ready_at, expires_at, created_at, updated_at`

func scanJob(row interface{ Scan(...any) error }) (Job, error) {
	var j Job
	var readyAt, expiresAt sql.NullTime
	err := row.Scan(&j.ID, &j.IdempotencyKey, &j.ClientID, &j.SeriesID, &j.Season, &j.Episode,
		&j.PickID, &j.State, &j.ReasonCode, &readyAt, &expiresAt, &j.CreatedAt, &j.UpdatedAt)
	if err != nil {
		return Job{}, err
	}
	if readyAt.Valid {
		t := readyAt.Time
		j.ReadyAt = &t
	}
	if expiresAt.Valid {
		t := expiresAt.Time
		j.ExpiresAt = &t
	}
	return j, nil
}

// Create implements the idempotent insert (contracts.md §3): the UNIQUE
// (client_id, idempotency_key) constraint plus ON CONFLICT DO NOTHING makes
// concurrent double-submits return the same job.
func (s *Store) Create(ctx context.Context, req CreateRequest) (Job, bool, error) {
	if req.ClientID == "" || req.IdempotencyKey == "" || req.SeriesID == "" || req.PickID <= 0 {
		return Job{}, false, ErrInvalidRequest
	}
	if req.Season < 0 || req.Episode < 0 {
		return Job{}, false, ErrInvalidRequest
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return Job{}, false, fmt.Errorf("begin create: %w", err)
	}
	defer tx.Rollback()
	var created bool
	err = tx.QueryRowContext(ctx, `
INSERT INTO download_jobs (idempotency_key, client_id, series_id, season, episode, pick_id, state)
VALUES ($1,$2,$3,$4,$5,$6,$7)
ON CONFLICT (client_id, idempotency_key) DO NOTHING
RETURNING TRUE`, req.IdempotencyKey, req.ClientID, req.SeriesID, req.Season, req.Episode, req.PickID, StatePreparing).Scan(&created)
	if errors.Is(err, sql.ErrNoRows) {
		created = false
	} else if err != nil {
		return Job{}, false, fmt.Errorf("insert job: %w", err)
	}
	j, err := scanJob(tx.QueryRowContext(ctx, `
SELECT `+jobColumns+` FROM download_jobs WHERE client_id=$1 AND idempotency_key=$2`,
		req.ClientID, req.IdempotencyKey))
	if err != nil {
		return Job{}, false, fmt.Errorf("read created job: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return Job{}, false, fmt.Errorf("commit create: %w", err)
	}
	return j, created, nil
}

func (s *Store) Get(ctx context.Context, clientID, jobID string) (Job, error) {
	j, err := scanJob(s.DB.QueryRowContext(ctx, `
SELECT `+jobColumns+` FROM download_jobs WHERE id=$1 AND client_id=$2`, jobID, clientID))
	if errors.Is(err, sql.ErrNoRows) {
		return Job{}, ErrNotFound
	}
	return j, err
}

// Cancel flips a preparing job to cancelled (client_cancelled); ready jobs
// respond ErrNotCancellable (device-side removal is not a server operation).
func (s *Store) Cancel(ctx context.Context, clientID, jobID string) (Job, error) {
	j, err := s.Get(ctx, clientID, jobID)
	if err != nil {
		return Job{}, err
	}
	if j.State != StatePreparing {
		return Job{}, ErrNotCancellable
	}
	return s.transition(ctx, j, StateCancelled, ReasonClientCancelled)
}

// Renew extends retention per contracts.md §5.
func (s *Store) Renew(ctx context.Context, clientID, jobID string, now time.Time) (Job, error) {
	j, err := s.Get(ctx, clientID, jobID)
	if err != nil {
		return Job{}, err
	}
	if j.State != StateReady || j.ReadyAt == nil || j.ExpiresAt == nil {
		return Job{}, ErrNotCancellable
	}
	extended, err := RenewedExpiry(*j.ReadyAt, *j.ExpiresAt, now)
	if err != nil {
		return Job{}, ErrExpired
	}
	if _, err := s.DB.ExecContext(ctx, `
UPDATE download_jobs SET expires_at=$1 WHERE id=$2`, extended, j.ID); err != nil {
		return Job{}, fmt.Errorf("renew job: %w", err)
	}
	return s.Get(ctx, clientID, jobID)
}

// transition applies a state-machine-validated change and returns the fresh job.
func (s *Store) transition(ctx context.Context, j Job, to, reason string) (Job, error) {
	if err := ValidateTransition(j.State, to); err != nil {
		return Job{}, ErrNotCancellable
	}
	if !ValidateReason(to, reason) {
		return Job{}, fmt.Errorf("illegal reason %q for state %q", reason, to)
	}
	tag, err := s.DB.ExecContext(ctx, `
UPDATE download_jobs SET state=$1, reason_code=$2 WHERE id=$3 AND state=$4`,
		to, reason, j.ID, j.State)
	if err != nil {
		return Job{}, fmt.Errorf("transition job: %w", err)
	}
	if n, _ := tag.RowsAffected(); n != 1 {
		// Concurrent change: re-read and let the caller re-decide.
		return Job{}, ErrNotCancellable
	}
	return s.Get(ctx, j.ClientID, j.ID)
}

// MarkReady attaches the complete validated manifest and starts the retention
// clock (contracts.md §4). The manifest is validated here so an invalid
// package can NEVER become ready (acceptance D7).
func (s *Store) MarkReady(ctx context.Context, jobID string, manifest Manifest, now time.Time) error {
	if err := ValidateManifest(manifest, now); err != nil {
		return fmt.Errorf("manifest rejected: %w", err)
	}
	if manifest.JobID != jobID {
		return fmt.Errorf("manifest jobId does not match the job")
	}
	if err := ValidateTransition(StatePreparing, StateReady); err != nil {
		return err
	}
	expiresAt := InitialExpiry(now)
	raw, err := json.Marshal(manifest)
	if err != nil {
		return fmt.Errorf("encode manifest: %w", err)
	}
	tag, err := s.DB.ExecContext(ctx, `
UPDATE download_jobs
SET state=$1, reason_code='', manifest=$2, ready_at=$3, expires_at=$4
WHERE id=$5 AND state=$6`, StateReady, raw, now, expiresAt, jobID, StatePreparing)
	if err != nil {
		return fmt.Errorf("mark ready: %w", err)
	}
	if n, _ := tag.RowsAffected(); n != 1 {
		return ErrNotCancellable
	}
	return nil
}

// Manifest returns the validated manifest of a ready job owned by the client.
func (s *Store) Manifest(ctx context.Context, clientID, jobID string) (Manifest, error) {
	var raw []byte
	err := s.DB.QueryRowContext(ctx, `
SELECT manifest FROM download_jobs WHERE id=$1 AND client_id=$2 AND state=$3`,
		jobID, clientID, StateReady).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return Manifest{}, ErrNotFound
	}
	if err != nil {
		return Manifest{}, fmt.Errorf("read manifest: %w", err)
	}
	var m Manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return Manifest{}, fmt.Errorf("decode manifest: %w", err)
	}
	// Defensive re-validation at read time: a stored manifest that no longer
	// validates (e.g. past expiry) is not served.
	now := time.Now().UTC()
	if err := ValidateManifest(m, now); err != nil {
		return Manifest{}, ErrNotReady
	}
	return m, nil
}

// ExpireDue flips ready jobs past their expiry to expired/retention_expired
// and returns their ids (bounded cleanup input, contracts.md §5).
func (s *Store) ExpireDue(ctx context.Context, now time.Time, limit int) ([]string, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := s.DB.QueryContext(ctx, `
UPDATE download_jobs
SET state=$1, reason_code=$2
WHERE id IN (
  SELECT id FROM download_jobs
  WHERE state=$3 AND expires_at < $4
  ORDER BY expires_at
  LIMIT $5
)
RETURNING id`, StateExpired, ReasonRetentionExpired, StateReady, now, limit)
	if err != nil {
		return nil, fmt.Errorf("expire due jobs: %w", err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan expired job id: %w", err)
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
