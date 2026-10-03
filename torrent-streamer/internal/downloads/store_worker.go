package downloads

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
)

// Worker-side store operations for the D02b prep pipeline (contracts.md §3–§5).
// All of these are called by the Prepper; the HTTP surface never touches them.

// ClaimPreparing atomically claims an unclaimed preparing job for this worker
// (bounded admission is the caller's count of running preps). Returns
// ErrNotFound when there is nothing claimable with that id.
func (s *Store) ClaimPreparing(ctx context.Context, jobID, workerID string) (Job, error) {
	tag, err := s.DB.ExecContext(ctx, `
UPDATE download_jobs SET claimed_by=$1, claimed_at=now()
WHERE id=$2 AND state=$3 AND claimed_by=''`, workerID, jobID, StatePreparing)
	if err != nil {
		return Job{}, fmt.Errorf("claim job: %w", err)
	}
	if n, _ := tag.RowsAffected(); n != 1 {
		return Job{}, ErrNotFound
	}
	var clientID string
	if err := s.DB.QueryRowContext(ctx, `SELECT client_id FROM download_jobs WHERE id=$1`, jobID).Scan(&clientID); err != nil {
		return Job{}, fmt.Errorf("read claimed job: %w", err)
	}
	return s.Get(ctx, clientID, jobID)
}

// NextUnclaimedPreparing returns up to limit preparing job ids that no worker
// holds yet (FIFO by creation) — the admission queue.
func (s *Store) NextUnclaimedPreparing(ctx context.Context, limit int) ([]string, error) {
	if limit <= 0 {
		limit = 1
	}
	rows, err := s.DB.QueryContext(ctx, `
SELECT id FROM download_jobs WHERE state=$1 AND claimed_by='' ORDER BY created_at LIMIT $2`,
		StatePreparing, limit)
	if err != nil {
		return nil, fmt.Errorf("list unclaimed jobs: %w", err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan job id: %w", err)
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// ReconcileStartup releases claims held by a previous process (contracts.md
// §3: "server restart resumes/reconciles preparing jobs"). Called once at
// boot before any worker runs.
func (s *Store) ReconcileStartup(ctx context.Context) (int64, error) {
	tag, err := s.DB.ExecContext(ctx, `
UPDATE download_jobs SET claimed_by='', claimed_at=NULL WHERE state=$1 AND claimed_by<>''`, StatePreparing)
	if err != nil {
		return 0, fmt.Errorf("reconcile preparing jobs: %w", err)
	}
	n, _ := tag.RowsAffected()
	return n, nil
}

// FailPreparing flips a still-preparing job to failed with a safe reason
// (contracts.md §3). A job that is no longer preparing (client cancelled
// concurrently) reports ErrNotCancellable; the worker then just cleans up.
func (s *Store) FailPreparing(ctx context.Context, jobID, reason string) error {
	if !ValidateReason(StateFailed, reason) {
		return fmt.Errorf("illegal failure reason %q", reason)
	}
	tag, err := s.DB.ExecContext(ctx, `
UPDATE download_jobs SET state=$1, reason_code=$2 WHERE id=$3 AND state=$4`,
		StateFailed, reason, jobID, StatePreparing)
	if err != nil {
		return fmt.Errorf("fail job: %w", err)
	}
	if n, _ := tag.RowsAffected(); n != 1 {
		return ErrNotCancellable
	}
	return nil
}

// AssetRow is one immutable file recorded for a ready job. DiskPath is
// server-relative to the downloads root (never an absolute or user path).
type AssetRow struct {
	Kind      string // video | subtitle
	Lang      string
	URLPath   string // the manifest/public URL path, e.g. /v1/downloads/jobs/<id>/assets/video
	DiskPath  string // relative to the downloads root, e.g. ready/<jobId>/video.mkv
	SizeBytes int64
	SHA256    string
}

// AssetFile resolves one asset URL path to its on-disk file for serving
// (contracts.md §4.1). The path is containment-checked against the resolved
// download root; the video asset is addressed as "video", subtitles as
// "subtitles/<lang>".
func (s *Store) AssetFile(ctx context.Context, clientID, jobID, urlPath string) (diskPath string, size int64, sha string, err error) {
	var rel string
	err = s.DB.QueryRowContext(ctx, `
SELECT a.asset_path, a.size_bytes, a.sha256
FROM download_assets a
JOIN download_jobs j ON j.id = a.job_id
WHERE a.job_id=$1 AND j.client_id=$2 AND j.state=$3 AND a.url_path=$4`,
		jobID, clientID, StateReady, urlPath).Scan(&rel, &size, &sha)
	if errors.Is(err, sql.ErrNoRows) {
		return "", 0, "", ErrNotFound
	}
	if err != nil {
		return "", 0, "", fmt.Errorf("read asset: %w", err)
	}
	if !isRelativeDownloadPath(rel) {
		return "", 0, "", ErrNotFound
	}
	return rel, size, sha, nil
}

// DeleteAssets removes the recorded assets of a job (retention cleanup,
// contracts.md §5). Delete files before rows so failed file cleanup is retryable.
func (s *Store) DeleteAssets(ctx context.Context, jobID string) error {
	_, err := s.DB.ExecContext(ctx, `DELETE FROM download_assets WHERE job_id=$1`, jobID)
	if err != nil {
		return fmt.Errorf("delete assets: %w", err)
	}
	return nil
}

// isRelativeDownloadPath rejects anything that could escape the downloads
// root: absolute paths, backslashes, drive letters, traversal, empty.
func isRelativeDownloadPath(rel string) bool {
	if rel == "" || filepath.IsAbs(rel) || strings.Contains(rel, "..") ||
		strings.Contains(rel, "\\") || strings.HasPrefix(rel, "/") {
		return false
	}
	return true
}
