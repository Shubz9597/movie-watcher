package watch

import (
	"context"
	"database/sql"
	"time"
)

type Store struct{ DB *sql.DB }

func NewStore(db *sql.DB) *Store { return &Store{DB: db} }

func (s *Store) SaveProgress(ctx context.Context, subjectID, seriesID string, season, episode, pos, dur int) error {
	percent := 0.0
	if dur > 0 {
		percent = float64(pos) / float64(dur) * 100.0
	}
	_, err := s.DB.ExecContext(ctx, `
INSERT INTO watch_progress (subject_id, series_id, season, episode, position_s, duration_s, percent, created_at, updated_at)
VALUES ($1,$2,$3,$4,$5,$6,$7, now(), now())
ON CONFLICT (subject_id, series_id, season, episode) DO UPDATE
SET position_s=EXCLUDED.position_s, duration_s=EXCLUDED.duration_s, percent=EXCLUDED.percent, updated_at=now()`,
		subjectID, seriesID, season, episode, pos, dur, percent)
	return err
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
	var r Resume
	err := s.DB.QueryRowContext(ctx, `
SELECT series_id, season, episode, position_s, duration_s, percent, updated_at
FROM watch_progress
WHERE subject_id=$1 AND series_id=$2
ORDER BY updated_at DESC LIMIT 1`,
		subjectID, seriesID).Scan(&r.SeriesID, &r.Season, &r.Episode, &r.Position, &r.Duration, &r.Percent, &r.Updated)
	if err != nil {
		if err == sql.ErrNoRows {
			return Resume{}, false, nil
		}
		return Resume{}, false, err
	}
	return r, true, nil
}

type ContinueItem struct {
	SeriesID  string    `json:"seriesId"`
	Season    int       `json:"season"`
	Episode   int       `json:"episode"`
	PositionS int       `json:"position_s"`
	DurationS int       `json:"duration_s"`
	Percent   float64   `json:"percent"`
	UpdatedAt time.Time `json:"updated_at"`
}

func (s *Store) ListContinue(ctx context.Context, subjectID string, limit int) ([]ContinueItem, error) {
	if limit <= 0 {
		limit = 30
	}
	rows, err := s.DB.QueryContext(ctx, `
SELECT wp.series_id, wp.season, wp.episode, wp.position_s, wp.duration_s, wp.percent, wp.updated_at
FROM watch_progress wp
LEFT JOIN continue_dismissals d
  ON d.subject_id=wp.subject_id AND d.series_id=wp.series_id AND d.season=wp.season AND d.episode=wp.episode
WHERE wp.subject_id=$1
  AND wp.percent BETWEEN 1 AND 95
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
		if err := rows.Scan(&it.SeriesID, &it.Season, &it.Episode, &it.PositionS, &it.DurationS, &it.Percent, &it.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, it)
	}
	return out, rows.Err()
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
