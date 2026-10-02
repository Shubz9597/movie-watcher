package watch

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"
)

type Store struct{ DB *sql.DB }

func NewStore(db *sql.DB) *Store { return &Store{DB: db} }

func (s *Store) SaveProgress(ctx context.Context, subjectID, seriesID string, season, episode, pos, dur int) error {
	_, err := s.SaveProgressUpdate(ctx, ProgressUpdate{
		SubjectID: subjectID,
		SeriesID:  seriesID,
		Season:    season,
		Episode:   episode,
		Position:  pos,
		Duration:  dur,
	})
	return err
}

type ProgressSource struct {
	URI       string
	Name      string
	Kind      string
	FileIndex *int
}

// EpisodeRef identifies an episode that can follow the current playback item.
// CompletedPercent is the watched threshold: at or past it an episode or
// movie counts as watched, leaves Continue watching, and (for episodes)
// queues the next one. 90% leaves room for long end credits.
const (
	CompletedPercent    = 90.0
	completedPercentSQL = "90"
)

type EpisodeRef struct {
	Season  int
	Episode int
}

// ProgressUpdate contains one playback checkpoint and its known successor.
// Next is optional; when the checkpoint is complete, it becomes the series'
// Continue Watching entry without overwriting any progress already saved for it.
//
// V2 ordering metadata (all optional — V1 callers omit them and behave
// exactly as before, contract rule 7):
//   - ClientID/SessionID/Seq enable the per-session sequence guard and
//     last-writer metadata (FR-006; clientId is opaque, never auth).
//   - LowFidelity marks the stream byte-ratio estimate so it never
//     overwrites a row written by an explicit client session.
type ProgressUpdate struct {
	SubjectID   string
	SeriesID    string
	Season      int
	Episode     int
	Position    int
	Duration    int
	Source      *ProgressSource
	Next        *EpisodeRef
	ClientID    string
	SessionID   string
	Seq         int64
	LowFidelity bool
}

// SaveResult reports whether the ordered write path accepted the update or
// ignored it under the contracted rules.
type SaveResult struct {
	Ignored string // "" when accepted; "stale_seq" | "stale_estimate"
}

// SaveProgressUpdate persists a checkpoint through the server-ordered write
// path and atomically queues its known successor when the current episode
// reaches the completion threshold. Ordering: commit-order LWW with a
// monotonic progress_revision; per-session seq guard; deliberate rewind is a
// valid write; furthest-position-wins is prohibited.
func (s *Store) SaveProgressUpdate(ctx context.Context, update ProgressUpdate) (SaveResult, error) {
	subjectID := strings.TrimSpace(update.SubjectID)
	seriesID := strings.TrimSpace(update.SeriesID)
	if subjectID == "" || seriesID == "" {
		return SaveResult{}, fmt.Errorf("subjectID and seriesID are required")
	}
	season, episode := update.Season, update.Episode
	if season < 0 || episode < 0 {
		return SaveResult{}, fmt.Errorf("season and episode cannot be negative")
	}
	pos, dur := update.Position, update.Duration
	if pos < 0 {
		pos = 0
	}
	if dur < 0 {
		dur = 0
	}
	if dur > 0 && pos > dur {
		pos = dur
	}
	var source *ProgressSource
	if update.Source != nil {
		sourceCopy := *update.Source
		source = &sourceCopy
		source.URI = strings.TrimSpace(source.URI)
		source.Name = strings.TrimSpace(source.Name)
		source.Kind = strings.TrimSpace(source.Kind)
		if source.URI == "" || len(source.URI) > 32768 || (source.FileIndex != nil && *source.FileIndex < 0) {
			return SaveResult{}, fmt.Errorf("invalid playback source")
		}
		if nameRunes := []rune(source.Name); len(nameRunes) > 1000 {
			source.Name = string(nameRunes[:1000])
		}
		if len(source.Kind) > 32 {
			return SaveResult{}, fmt.Errorf("invalid source kind")
		}
	}
	var next *EpisodeRef
	if update.Next != nil {
		nextCopy := *update.Next
		if nextCopy.Season < 0 || nextCopy.Episode <= 0 {
			return SaveResult{}, fmt.Errorf("invalid next episode")
		}
		if nextCopy.Season == season && nextCopy.Episode == episode {
			return SaveResult{}, fmt.Errorf("next episode must differ from current episode")
		}
		next = &nextCopy
	}

	percent := 0.0
	if dur > 0 {
		percent = float64(pos) / float64(dur) * 100.0
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return SaveResult{}, fmt.Errorf("begin progress transaction: %w", err)
	}
	defer tx.Rollback()

	// Ensure the row exists before locking it. ON CONFLICT waits for another
	// first writer, so concurrent inserts follow the same ordering as updates.
	if _, err := tx.ExecContext(ctx, `
INSERT INTO watch_progress (subject_id, series_id, season, episode, position_s, duration_s, percent, progress_revision)
VALUES ($1,$2,$3,$4,0,0,0,0)
ON CONFLICT (subject_id, series_id, season, episode) DO NOTHING`,
		subjectID, seriesID, season, episode); err != nil {
		return SaveResult{}, fmt.Errorf("ensure progress row: %w", err)
	}
	var state ProgressRowState
	var progressID int64
	err = tx.QueryRowContext(ctx, `
SELECT id, progress_revision, COALESCE(stream_session_id, '')
FROM watch_progress
WHERE subject_id=$1 AND series_id=$2 AND season=$3 AND episode=$4
FOR UPDATE`,
		subjectID, seriesID, season, episode).Scan(&progressID, &state.Revision, &state.SessionID)
	if err != nil {
		return SaveResult{}, fmt.Errorf("lock progress row: %w", err)
	}
	state.Exists = state.Revision > 0
	update.SessionID = strings.TrimSpace(update.SessionID)
	if update.SessionID != "" {
		var lastSeq int64
		err := tx.QueryRowContext(ctx, `
SELECT last_seq FROM watch_progress_sessions
WHERE progress_id=$1 AND session_id=$2`, progressID, update.SessionID).Scan(&lastSeq)
		switch {
		case err == nil:
			state.LastSeq = &lastSeq
		case errors.Is(err, sql.ErrNoRows):
			// This session has not written progress for this item yet.
		default:
			return SaveResult{}, fmt.Errorf("read session sequence: %w", err)
		}
	}

	decision := DecideOrderedWrite(state, update)
	if !decision.Accepted {
		return SaveResult{Ignored: decision.Ignored}, tx.Commit()
	}

	var sourceURI, sourceName, sourceKind any
	var sourceFileIndex any
	if source != nil {
		sourceURI, sourceName, sourceKind = source.URI, source.Name, source.Kind
		if source.FileIndex != nil {
			sourceFileIndex = *source.FileIndex
		}
	}
	writerClientID := strings.TrimSpace(update.ClientID)
	sessionID := strings.TrimSpace(update.SessionID)
	var writerArg, sessionArg any
	if sessionID != "" {
		// Last-writer metadata is recorded only for explicit client sessions;
		// anonymous (legacy/auto-save) writes leave it untouched.
		writerArg, sessionArg = writerClientID, sessionID
	}

	if _, err = tx.ExecContext(ctx, `
UPDATE watch_progress
SET position_s=$5, duration_s=$6, percent=$7,
    source_uri=COALESCE($8, source_uri),
    source_name=COALESCE($9, source_name),
    source_kind=COALESCE($10, source_kind),
    source_file_index=COALESCE($11, source_file_index),
    progress_revision=$12,
    writer_client_id=COALESCE($13, writer_client_id),
    stream_session_id=COALESCE($14, stream_session_id),
    last_seq=CASE WHEN COALESCE($14, '') <> '' THEN $15 ELSE last_seq END,
    updated_at=now()
WHERE subject_id=$1 AND series_id=$2 AND season=$3 AND episode=$4`,
		subjectID, seriesID, season, episode, pos, dur, percent,
		sourceURI, sourceName, sourceKind, sourceFileIndex,
		decision.NextRevision, writerArg, sessionArg, update.Seq); err != nil {
		return SaveResult{}, fmt.Errorf("save episode progress: %w", err)
	}
	if sessionID != "" {
		if _, err := tx.ExecContext(ctx, `
INSERT INTO watch_progress_sessions (progress_id, session_id, last_seq)
VALUES ($1,$2,$3)
ON CONFLICT (progress_id, session_id) DO UPDATE SET last_seq=EXCLUDED.last_seq`,
			progressID, sessionID, update.Seq); err != nil {
			return SaveResult{}, fmt.Errorf("save session sequence: %w", err)
		}
	}

	// A new partial watch makes any old dismissal for this item stale.
	// Completion itself is represented by percent >= CompletedPercent.
	if pos > 0 && percent < CompletedPercent {
		if _, err = tx.ExecContext(ctx, `
DELETE FROM continue_dismissals
WHERE subject_id=$1 AND series_id=$2 AND season=$3 AND episode=$4`,
			subjectID, seriesID, season, episode); err != nil {
			return SaveResult{}, fmt.Errorf("clear progress dismissal: %w", err)
		}
	}

	if percent >= CompletedPercent && next != nil {
		if _, err = tx.ExecContext(ctx, `
INSERT INTO watch_progress (
  subject_id, series_id, season, episode, position_s, duration_s, percent, created_at, updated_at
)
VALUES ($1,$2,$3,$4,0,0,0,now(),now())
ON CONFLICT (subject_id, series_id, season, episode) DO UPDATE
SET updated_at=now()`, subjectID, seriesID, next.Season, next.Episode); err != nil {
			return SaveResult{}, fmt.Errorf("queue next episode: %w", err)
		}
		if _, err = tx.ExecContext(ctx, `
DELETE FROM continue_dismissals
WHERE subject_id=$1 AND series_id=$2 AND season=$3 AND episode=$4`,
			subjectID, seriesID, next.Season, next.Episode); err != nil {
			return SaveResult{}, fmt.Errorf("clear next episode dismissal: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
		return SaveResult{}, fmt.Errorf("commit progress transaction: %w", err)
	}
	return SaveResult{}, nil
}

type Resume struct {
	SeriesID string
	Season   int
	Episode  int
	Position int
	Duration int
	Percent  float64
	Updated  time.Time
}

func (s *Store) GetResume(ctx context.Context, subjectID, seriesID string) (Resume, bool, error) {
	return s.getResume(ctx, subjectID, seriesID, nil, nil)
}

func (s *Store) GetEpisodeResume(ctx context.Context, subjectID, seriesID string, season, episode int) (Resume, bool, error) {
	return s.getResume(ctx, subjectID, seriesID, &season, &episode)
}

func (s *Store) getResume(ctx context.Context, subjectID, seriesID string, season, episode *int) (Resume, bool, error) {
	var r Resume
	query := `
SELECT series_id, season, episode, position_s, duration_s, percent, updated_at
FROM watch_progress
WHERE subject_id=$1 AND series_id=$2
  AND position_s > 0
  AND (duration_s <= 0 OR percent < ` + completedPercentSQL + `)`
	args := []any{subjectID, seriesID}
	if season != nil && episode != nil {
		query += ` AND season=$3 AND episode=$4`
		args = append(args, *season, *episode)
	}
	query += ` ORDER BY updated_at DESC LIMIT 1`
	err := s.DB.QueryRowContext(ctx, query, args...).Scan(
		&r.SeriesID, &r.Season, &r.Episode, &r.Position, &r.Duration, &r.Percent, &r.Updated,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return Resume{}, false, nil
		}
		return Resume{}, false, err
	}
	return r, true, nil
}

type ContinueItem struct {
	SeriesID        string    `json:"seriesId"`
	Season          int       `json:"season"`
	Episode         int       `json:"episode"`
	PositionS       int       `json:"position_s"`
	DurationS       int       `json:"duration_s"`
	Percent         float64   `json:"percent"`
	UpdatedAt       time.Time `json:"updated_at"`
	SourceAvailable bool      `json:"sourceAvailable"`
	SourceName      string    `json:"sourceName,omitempty"`
}

func (s *Store) ListContinue(ctx context.Context, subjectID string, limit int) ([]ContinueItem, error) {
	if limit <= 0 {
		limit = 30
	}
	rows, err := s.DB.QueryContext(ctx, `
WITH series_rows AS (
  SELECT wp.*,
         max(wp.updated_at) OVER (PARTITION BY wp.series_id) AS series_updated_at
  FROM watch_progress wp
  WHERE wp.subject_id=$1
),
latest AS (
  SELECT wp.*,
         row_number() OVER (PARTITION BY wp.series_id ORDER BY wp.updated_at DESC, wp.id DESC) AS rn
  FROM series_rows wp
  WHERE wp.updated_at=wp.series_updated_at
    AND (
      (wp.position_s >= 10 AND wp.duration_s > 0 AND wp.percent < `+completedPercentSQL+`)
      OR (wp.position_s = 0 AND wp.duration_s = 0 AND wp.percent = 0)
    )
)
SELECT wp.series_id, wp.season, wp.episode, wp.position_s, wp.duration_s, wp.percent, wp.updated_at,
       wp.source_uri IS NOT NULL, COALESCE(wp.source_name, '')
FROM latest wp
LEFT JOIN continue_dismissals d
  ON d.subject_id=wp.subject_id AND d.series_id=wp.series_id AND d.season=wp.season AND d.episode=wp.episode
WHERE wp.rn=1
  AND d.subject_id IS NULL
ORDER BY wp.updated_at DESC
LIMIT $2`, subjectID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ContinueItem
	for rows.Next() {
		var it ContinueItem
		if err := rows.Scan(
			&it.SeriesID, &it.Season, &it.Episode, &it.PositionS, &it.DurationS, &it.Percent, &it.UpdatedAt,
			&it.SourceAvailable, &it.SourceName,
		); err != nil {
			return nil, err
		}
		out = append(out, it)
	}
	return out, rows.Err()
}

func (s *Store) GetProgressSource(ctx context.Context, subjectID, seriesID string, season, episode int) (ProgressSource, bool, error) {
	var source ProgressSource
	var fileIndex sql.NullInt64
	err := s.DB.QueryRowContext(ctx, `
SELECT source_uri, COALESCE(source_name, ''), COALESCE(source_kind, ''), source_file_index
FROM watch_progress
WHERE subject_id=$1 AND series_id=$2 AND season=$3 AND episode=$4
  AND source_uri IS NOT NULL
  AND position_s > 0
LIMIT 1`, subjectID, seriesID, season, episode).Scan(
		&source.URI, &source.Name, &source.Kind, &fileIndex,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ProgressSource{}, false, nil
		}
		return ProgressSource{}, false, fmt.Errorf("query playback source: %w", err)
	}
	if fileIndex.Valid {
		value := int(fileIndex.Int64)
		source.FileIndex = &value
	}
	return source, true, nil
}

func (s *Store) Dismiss(ctx context.Context, subjectID, seriesID string, season, episode int, reason string) error {
	if reason == "" {
		reason = "manual"
	}
	_, err := s.DB.ExecContext(ctx, `
INSERT INTO continue_dismissals(subject_id,series_id,season,episode,reason)
VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, subjectID, seriesID, season, episode, reason)
	return err
}

// WatchedEpisode is one item's watched state for a subject.
type WatchedEpisode struct {
	Season    int
	Episode   int
	PositionS int
	DurationS int
	Percent   float64
	Watched   bool
}

// ListWatched returns the items of one title the subject has started or
// finished (movies use season 0, episode 0).
func (s *Store) ListWatched(ctx context.Context, subjectID, seriesID string) ([]WatchedEpisode, error) {
	rows, err := s.DB.QueryContext(ctx, `
SELECT season, episode, position_s, duration_s, percent
FROM watch_progress
WHERE subject_id=$1 AND series_id=$2 AND (percent > 0 OR position_s > 0)
ORDER BY season, episode`, subjectID, seriesID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []WatchedEpisode{}
	for rows.Next() {
		var item WatchedEpisode
		if err := rows.Scan(&item.Season, &item.Episode, &item.PositionS, &item.DurationS, &item.Percent); err != nil {
			return nil, err
		}
		item.Watched = item.Percent >= CompletedPercent
		out = append(out, item)
	}
	return out, rows.Err()
}

// SetWatched marks items watched (percent 100, out of Continue watching) or
// unwatched (progress cleared). Marking watched with a next episode queues it
// in Continue watching, the same way finishing an episode does.
func (s *Store) SetWatched(ctx context.Context, subjectID, seriesID string, items []EpisodeRef, watched bool, next *EpisodeRef) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, item := range items {
		if watched {
			if _, err := tx.ExecContext(ctx, `
INSERT INTO watch_progress (subject_id, series_id, season, episode, position_s, duration_s, percent, created_at, updated_at)
VALUES ($1,$2,$3,$4,0,0,100,now(),now())
ON CONFLICT (subject_id, series_id, season, episode) DO UPDATE
SET percent=100, position_s=GREATEST(watch_progress.position_s, watch_progress.duration_s), updated_at=now()`,
				subjectID, seriesID, item.Season, item.Episode); err != nil {
				return fmt.Errorf("mark watched: %w", err)
			}
			continue
		}
		if _, err := tx.ExecContext(ctx, `
DELETE FROM watch_progress WHERE subject_id=$1 AND series_id=$2 AND season=$3 AND episode=$4`,
			subjectID, seriesID, item.Season, item.Episode); err != nil {
			return fmt.Errorf("mark unwatched: %w", err)
		}
	}
	if watched && next != nil {
		if _, err := tx.ExecContext(ctx, `
INSERT INTO watch_progress (subject_id, series_id, season, episode, position_s, duration_s, percent, created_at, updated_at)
VALUES ($1,$2,$3,$4,0,0,0,now(),now())
ON CONFLICT (subject_id, series_id, season, episode) DO UPDATE
SET updated_at=now() WHERE watch_progress.percent < `+completedPercentSQL,
			subjectID, seriesID, next.Season, next.Episode); err != nil {
			return fmt.Errorf("queue next episode: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `
DELETE FROM continue_dismissals WHERE subject_id=$1 AND series_id=$2 AND season=$3 AND episode=$4`,
			subjectID, seriesID, next.Season, next.Episode); err != nil {
			return fmt.Errorf("clear next dismissal: %w", err)
		}
	}
	return tx.Commit()
}

// OfflineProgress is a position recorded by a device while offline
// (downloaded playback), synced when the device reconnects.
type OfflineProgress struct {
	SeriesID  string
	Season    int
	Episode   int
	PositionS int
	DurationS int
	WatchedAt time.Time
}

// SyncOffline applies offline positions without clobbering newer or
// completed server state: an item is written when the server has no record,
// when the offline watch completes an item the server had not, or when the
// server record is older than the offline watch. A completed item is never
// moved back to partial. Returns how many items were applied.
func (s *Store) SyncOffline(ctx context.Context, subjectID string, items []OfflineProgress) (int, error) {
	applied := 0
	for _, item := range items {
		if item.SeriesID == "" || item.DurationS <= 0 || item.PositionS <= 0 {
			continue
		}
		percent := math.Min(100, float64(item.PositionS)*100/float64(item.DurationS))
		watchedAt := item.WatchedAt
		if watchedAt.IsZero() || watchedAt.After(time.Now()) {
			watchedAt = time.Now()
		}
		res, err := s.DB.ExecContext(ctx, `
INSERT INTO watch_progress (subject_id, series_id, season, episode, position_s, duration_s, percent, created_at, updated_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
ON CONFLICT (subject_id, series_id, season, episode) DO UPDATE
SET position_s=EXCLUDED.position_s, duration_s=EXCLUDED.duration_s, percent=EXCLUDED.percent
WHERE (EXCLUDED.percent >= `+completedPercentSQL+` AND watch_progress.percent < `+completedPercentSQL+`)
   OR (watch_progress.percent < `+completedPercentSQL+` AND watch_progress.updated_at <= EXCLUDED.updated_at)`,
			subjectID, item.SeriesID, item.Season, item.Episode, item.PositionS, item.DurationS, percent, watchedAt)
		if err != nil {
			return applied, fmt.Errorf("sync offline progress: %w", err)
		}
		if n, _ := res.RowsAffected(); n > 0 {
			applied++
		}
	}
	return applied, nil
}
