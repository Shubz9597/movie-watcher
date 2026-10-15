// Package rekey moves saved state from AniList entry ids to their shows.
//
// Show pages (tmdb:tv:N, Stremio's seasons) own a show's progress, library
// place and learned skip songs. State saved before that under an AniList
// entry (one season or arc: "anilist:6033" is Dragon Ball Z Kai's first
// season) moves to the show's season and episode. Runs at start, once the
// anime list is loaded; rows already moved are not seen again.
package rekey

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"strings"

	"torrent-streamer/internal/watch"
)

// Run moves every placeable entry's rows.
func Run(ctx context.Context, db *sql.DB, placer watch.Placer) error {
	moved := map[string]int{}
	steps := []struct {
		name string
		run  func(context.Context, *sql.DB, watch.Placer) (int, error)
	}{
		{"progress", moveProgress},
		{"dismissals", moveDismissals},
		{"library", moveLibrary},
		{"skip songs", moveSkipThemes},
		{"skip fingerprints", moveSkipFingerprints},
	}
	for _, step := range steps {
		n, err := step.run(ctx, db, placer)
		if err != nil {
			return fmt.Errorf("move %s: %w", step.name, err)
		}
		if n > 0 {
			moved[step.name] = n
		}
	}
	if len(moved) > 0 {
		log.Printf("[catalog] moved AniList entries to their shows: %v", moved)
	}
	return nil
}

type progressRow struct {
	id              int64
	subject, series string
	season, episode int
}

// moveProgress re-inserts each row under the show (an UPDATE would reset
// updated_at, which orders Continue watching); where the show already has
// the episode, the newer row stays.
func moveProgress(ctx context.Context, db *sql.DB, placer watch.Placer) (int, error) {
	rows, err := db.QueryContext(ctx, `
SELECT id, subject_id, series_id, season, episode FROM watch_progress
WHERE series_id LIKE 'anilist:%' AND season > 0 AND episode > 0`)
	if err != nil {
		return 0, err
	}
	var pending []progressRow
	for rows.Next() {
		var r progressRow
		if err := rows.Scan(&r.id, &r.subject, &r.series, &r.season, &r.episode); err != nil {
			rows.Close()
			return 0, err
		}
		pending = append(pending, r)
	}
	rows.Close()
	moved := 0
	for _, r := range pending {
		show, season, episode, ok := placer.PlaceEpisode(ctx, r.series, r.episode)
		if !ok {
			continue
		}
		if err := inTx(ctx, db, func(tx *sql.Tx) error {
			var existingID int64
			var existingNewer bool
			err := tx.QueryRowContext(ctx, `
SELECT t.id, t.updated_at >= o.updated_at FROM watch_progress t, watch_progress o
WHERE o.id=$1 AND t.subject_id=o.subject_id AND t.series_id=$2 AND t.season=$3 AND t.episode=$4`,
				r.id, show, season, episode).Scan(&existingID, &existingNewer)
			switch {
			case err == sql.ErrNoRows:
			case err != nil:
				return err
			case existingNewer:
				_, err = tx.ExecContext(ctx, `DELETE FROM watch_progress WHERE id=$1`, r.id)
				return err
			default:
				if _, err := tx.ExecContext(ctx, `DELETE FROM watch_progress WHERE id=$1`, existingID); err != nil {
					return err
				}
			}
			if _, err := tx.ExecContext(ctx, `
INSERT INTO watch_progress (subject_id, series_id, season, episode, position_s, duration_s, percent,
  source_uri, source_name, source_kind, source_file_index, created_at, updated_at,
  progress_revision, writer_client_id, stream_session_id, last_seq)
SELECT subject_id, $2, $3, $4, position_s, duration_s, percent,
  source_uri, source_name, source_kind, source_file_index, created_at, updated_at,
  progress_revision, writer_client_id, stream_session_id, last_seq
FROM watch_progress WHERE id=$1`, r.id, show, season, episode); err != nil {
				return err
			}
			_, err = tx.ExecContext(ctx, `DELETE FROM watch_progress WHERE id=$1`, r.id)
			return err
		}); err != nil {
			return moved, err
		}
		moved++
	}
	return moved, nil
}

func moveDismissals(ctx context.Context, db *sql.DB, placer watch.Placer) (int, error) {
	type row struct {
		subject, series string
		season, episode int
	}
	rows, err := db.QueryContext(ctx, `
SELECT subject_id, series_id, season, episode FROM continue_dismissals
WHERE series_id LIKE 'anilist:%' AND season > 0 AND episode > 0`)
	if err != nil {
		return 0, err
	}
	var pending []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.subject, &r.series, &r.season, &r.episode); err != nil {
			rows.Close()
			return 0, err
		}
		pending = append(pending, r)
	}
	rows.Close()
	moved := 0
	for _, r := range pending {
		show, season, episode, ok := placer.PlaceEpisode(ctx, r.series, r.episode)
		if !ok {
			continue
		}
		if err := inTx(ctx, db, func(tx *sql.Tx) error {
			if _, err := tx.ExecContext(ctx, `
INSERT INTO continue_dismissals (subject_id, series_id, season, episode, reason, created_at)
SELECT subject_id, $5, $6, $7, reason, created_at FROM continue_dismissals
WHERE subject_id=$1 AND series_id=$2 AND season=$3 AND episode=$4
ON CONFLICT DO NOTHING`, r.subject, r.series, r.season, r.episode, show, season, episode); err != nil {
				return err
			}
			_, err := tx.ExecContext(ctx, `DELETE FROM continue_dismissals WHERE subject_id=$1 AND series_id=$2 AND season=$3 AND episode=$4`,
				r.subject, r.series, r.season, r.episode)
			return err
		}); err != nil {
			return moved, err
		}
		moved++
	}
	return moved, nil
}

// entryShow is the show an entry id belongs to ("" when it cannot be
// placed in one season).
func entryShow(ctx context.Context, placer watch.Placer, id string) string {
	show, _, _, ok := placer.EntrySeason(ctx, id)
	if !ok {
		return ""
	}
	return show
}

// moveLibrary keeps one library place per show: an entry's Watch Later and
// Favourite marks join the show's.
func moveLibrary(ctx context.Context, db *sql.DB, placer watch.Placer) (int, error) {
	ids, err := distinct(ctx, db, `SELECT DISTINCT canonical_id FROM library_memberships WHERE canonical_id LIKE 'anilist:%'`)
	if err != nil {
		return 0, err
	}
	moved := 0
	for _, id := range ids {
		show := entryShow(ctx, placer, id)
		if show == "" {
			continue
		}
		if err := inTx(ctx, db, func(tx *sql.Tx) error {
			if _, err := tx.ExecContext(ctx, `
UPDATE library_memberships t SET
  watch_later = t.watch_later OR o.watch_later,
  favourite = t.favourite OR o.favourite,
  watch_later_added_at = COALESCE(t.watch_later_added_at, o.watch_later_added_at),
  favourite_added_at = COALESCE(t.favourite_added_at, o.favourite_added_at)
FROM library_memberships o
WHERE o.canonical_id=$1 AND t.canonical_id=$2 AND t.household_id=o.household_id`, id, show); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `
DELETE FROM library_memberships o USING library_memberships t
WHERE o.canonical_id=$1 AND t.canonical_id=$2 AND t.household_id=o.household_id`, id, show); err != nil {
				return err
			}
			_, err := tx.ExecContext(ctx, `UPDATE library_memberships SET canonical_id=$2 WHERE canonical_id=$1`, id, show)
			return err
		}); err != nil {
			return moved, err
		}
		moved++
	}
	return moved, nil
}

// moveSkipThemes: a show's learned openings and endings are one set, every
// season's songs together (the matcher searches them all).
func moveSkipThemes(ctx context.Context, db *sql.DB, placer watch.Placer) (int, error) {
	ids, err := distinct(ctx, db, `SELECT DISTINCT series_key FROM skip_themes WHERE series_key LIKE 'anilist:%'`)
	if err != nil {
		return 0, err
	}
	moved := 0
	for _, id := range ids {
		show := entryShow(ctx, placer, id)
		if show == "" {
			continue
		}
		if err := inTx(ctx, db, func(tx *sql.Tx) error {
			if _, err := tx.ExecContext(ctx, `
INSERT INTO skip_themes (series_key, kind, source, data, created_at)
SELECT $2, kind, source, data, created_at FROM skip_themes WHERE series_key=$1
ON CONFLICT DO NOTHING`, id, show); err != nil {
				return err
			}
			_, err := tx.ExecContext(ctx, `DELETE FROM skip_themes WHERE series_key=$1`, id)
			return err
		}); err != nil {
			return moved, err
		}
		moved++
	}
	return moved, nil
}

func moveSkipFingerprints(ctx context.Context, db *sql.DB, placer watch.Placer) (int, error) {
	ids, err := distinct(ctx, db, `SELECT DISTINCT series_key FROM skip_fingerprints WHERE series_key LIKE 'anilist:%'`)
	if err != nil {
		return 0, err
	}
	moved := 0
	for _, id := range ids {
		show, season, offset, ok := placer.EntrySeason(ctx, id)
		if !ok {
			continue
		}
		result, err := db.ExecContext(ctx, `
UPDATE skip_fingerprints SET series_key=$2, season=$3, episode=episode+$4
WHERE series_key=$1 AND episode > 0`, id, show, season, offset)
		if err != nil {
			return moved, err
		}
		n, _ := result.RowsAffected()
		moved += int(n)
	}
	return moved, nil
}

func distinct(ctx context.Context, db *sql.DB, query string) ([]string, error) {
	rows, err := db.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var value string
		if err := rows.Scan(&value); err != nil {
			return nil, err
		}
		if strings.TrimSpace(value) != "" {
			out = append(out, value)
		}
	}
	return out, rows.Err()
}

func inTx(ctx context.Context, db *sql.DB, work func(*sql.Tx) error) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := work(tx); err != nil {
		return err
	}
	return tx.Commit()
}
