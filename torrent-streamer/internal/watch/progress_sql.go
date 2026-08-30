package watch

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

type Store struct{ DB *sql.DB }

func NewStore(db *sql.DB) *Store { return &Store{DB: db} }

func (s *Store) SaveProgress(ctx context.Context, subjectID, seriesID string, season, episode, pos, dur int) error {
	return s.SaveProgressUpdate(ctx, ProgressUpdate{
		SubjectID: subjectID,
		SeriesID:  seriesID,
		Season:    season,
		Episode:   episode,
		Position:  pos,
		Duration:  dur,
	})
}

type ProgressSource struct {
	URI       string
	Name      string
	Kind      string
	FileIndex *int
}

// EpisodeRef identifies an episode that can follow the current playback item.
type EpisodeRef struct {
	Season  int
	Episode int
}

// ProgressUpdate contains one playback checkpoint and its known successor.
// Next is optional; when the checkpoint is complete, it becomes the series'
// Continue Watching entry without overwriting any progress already saved for it.
type ProgressUpdate struct {
	SubjectID string
	SeriesID  string
	Season    int
	Episode   int
	Position  int
	Duration  int
	Source    *ProgressSource
	Next      *EpisodeRef
}

func (s *Store) SaveProgressWithSource(ctx context.Context, subjectID, seriesID string, season, episode, pos, dur int, source *ProgressSource) error {
	return s.SaveProgressUpdate(ctx, ProgressUpdate{
		SubjectID: subjectID,
		SeriesID:  seriesID,
		Season:    season,
		Episode:   episode,
		Position:  pos,
		Duration:  dur,
		Source:    source,
	})
}

// SaveProgressUpdate persists a checkpoint and atomically queues its known
// successor when the current episode reaches the completion threshold.
func (s *Store) SaveProgressUpdate(ctx context.Context, update ProgressUpdate) error {
	subjectID := strings.TrimSpace(update.SubjectID)
	seriesID := strings.TrimSpace(update.SeriesID)
	if subjectID == "" || seriesID == "" {
		return fmt.Errorf("subjectID and seriesID are required")
	}
	season, episode := update.Season, update.Episode
	if season < 0 || episode < 0 {
		return fmt.Errorf("season and episode cannot be negative")
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
			return fmt.Errorf("invalid playback source")
		}
		if nameRunes := []rune(source.Name); len(nameRunes) > 1000 {
			source.Name = string(nameRunes[:1000])
		}
		if len(source.Kind) > 32 {
			return fmt.Errorf("invalid source kind")
		}
	}
	var next *EpisodeRef
	if update.Next != nil {
		nextCopy := *update.Next
		if nextCopy.Season < 0 || nextCopy.Episode <= 0 {
			return fmt.Errorf("invalid next episode")
		}
		if nextCopy.Season == season && nextCopy.Episode == episode {
			return fmt.Errorf("next episode must differ from current episode")
		}
		next = &nextCopy
	}

	percent := 0.0
	if dur > 0 {
		percent = float64(pos) / float64(dur) * 100.0
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin progress transaction: %w", err)
	}
	defer tx.Rollback()

	var sourceURI, sourceName, sourceKind any
	var sourceFileIndex any
	if source != nil {
		sourceURI, sourceName, sourceKind = source.URI, source.Name, source.Kind
		if source.FileIndex != nil {
			sourceFileIndex = *source.FileIndex
		}
	}
	if _, err = tx.ExecContext(ctx, `
INSERT INTO watch_progress (
  subject_id, series_id, season, episode, position_s, duration_s, percent,
  source_uri, source_name, source_kind, source_file_index, created_at, updated_at
)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now(), now())
ON CONFLICT (subject_id, series_id, season, episode) DO UPDATE
SET position_s=EXCLUDED.position_s,
    duration_s=EXCLUDED.duration_s,
    percent=EXCLUDED.percent,
    source_uri=COALESCE(EXCLUDED.source_uri, watch_progress.source_uri),
    source_name=COALESCE(EXCLUDED.source_name, watch_progress.source_name),
    source_kind=COALESCE(EXCLUDED.source_kind, watch_progress.source_kind),
    source_file_index=COALESCE(EXCLUDED.source_file_index, watch_progress.source_file_index),
    updated_at=now()`,
		subjectID, seriesID, season, episode, pos, dur, percent,
		sourceURI, sourceName, sourceKind, sourceFileIndex); err != nil {
		return fmt.Errorf("save episode progress: %w", err)
	}

	// A new partial watch makes any old dismissal for this item stale.
	// Completion itself is represented by percent >= 95.
	if pos > 0 && percent < 95 {
		if _, err = tx.ExecContext(ctx, `
DELETE FROM continue_dismissals
WHERE subject_id=$1 AND series_id=$2 AND season=$3 AND episode=$4`,
			subjectID, seriesID, season, episode); err != nil {
			return fmt.Errorf("clear progress dismissal: %w", err)
		}
	}

	if percent >= 95 && next != nil {
		if _, err = tx.ExecContext(ctx, `
INSERT INTO watch_progress (
  subject_id, series_id, season, episode, position_s, duration_s, percent, created_at, updated_at
)
VALUES ($1,$2,$3,$4,0,0,0,now(),now())
ON CONFLICT (subject_id, series_id, season, episode) DO UPDATE
SET updated_at=now()`, subjectID, seriesID, next.Season, next.Episode); err != nil {
			return fmt.Errorf("queue next episode: %w", err)
		}
		if _, err = tx.ExecContext(ctx, `
DELETE FROM continue_dismissals
WHERE subject_id=$1 AND series_id=$2 AND season=$3 AND episode=$4`,
			subjectID, seriesID, next.Season, next.Episode); err != nil {
			return fmt.Errorf("clear next episode dismissal: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit progress transaction: %w", err)
	}
	return nil
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
  AND (duration_s <= 0 OR percent < 95)`
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
      (wp.position_s >= 10 AND wp.duration_s > 0 AND wp.percent < 95)
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
func (s *Store) MarkCompleted(ctx context.Context, subjectID, seriesID string, season, episode int) error {
	return s.Dismiss(ctx, subjectID, seriesID, season, episode, "completed")
}
