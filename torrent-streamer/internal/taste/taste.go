// Package taste collects and derives the household taste signals that feed
// the v2 recommendation engine.
//
// Signal sources (household-wide — subject_id is per-device attribution for
// dedup only, never a profile key):
//   - favourites        weight 5  (derived: library_memberships.favourite)
//   - watch later       weight 3  (derived: library_memberships.watch_later)
//   - watched ≥50%      weight 4  (derived: watch_progress, latest per series)
//   - started (<50%)    weight 2  (derived: watch_progress, latest per series)
//   - opened title      weight 1  (collected: taste_events "visited" pings)
//
// Progress rows at ≥90% are reported with label "completed" and weight 0:
// completed titles join the recommendation EXCLUSION set instead of the
// profile. Everything is derived at profile-build time except visits — so a
// freshly deployed (empty) database works immediately and hydrates from
// normal usage; nothing needs to be copied between environments.
package taste

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

// Signal is one household taste signal.
type Signal struct {
	CanonicalID string
	Kind        string  // movie | series | anime (may be empty for visits)
	Label       string  // favourited | watch-later | watched | started | completed | opened
	Weight      float64
	Title       string  // display title when a snapshot/name is available
}

// Store is the SQL-backed taste signal store (migrations/008).
type Store struct {
	DB *sql.DB
}

// New wires the store; the database must already have migration 008 applied
// (migrations run automatically at boot).
func New(db *sql.DB) *Store { return &Store{DB: db} }

var errNotConfigured = errors.New("taste: store is not configured")

const householdID = 1 // single private household (migrations/007)

// RecordVisit stores one fire-and-forget "opened title" ping, deduplicated
// per (subject, title) within a 6-hour cooldown window. Best-effort by
// design: callers treat every error as ignorable.
func (s *Store) RecordVisit(ctx context.Context, subjectID, canonicalID, kind string) error {
	if s == nil || s.DB == nil {
		return errNotConfigured
	}
	subjectID, canonicalID = strings.TrimSpace(subjectID), strings.TrimSpace(canonicalID)
	if subjectID == "" || canonicalID == "" {
		return errNotConfigured
	}
	_, err := s.DB.ExecContext(ctx, `
INSERT INTO taste_events (subject_id, canonical_id, kind)
SELECT $1, $2, $3
WHERE NOT EXISTS (
  SELECT 1 FROM taste_events
  WHERE subject_id = $1 AND canonical_id = $2
    AND created_at > now() - interval '6 hours'
)`, subjectID, canonicalID, kind)
	return err
}

// HouseholdSignals returns every active taste signal, deduplicated per
// canonical title (max-weight signal wins: a favourited title that is also in
// Watch Later contributes once, as a favourite).
func (s *Store) HouseholdSignals(ctx context.Context) ([]Signal, error) {
	if s == nil || s.DB == nil {
		return nil, errNotConfigured
	}
	signals := make([]Signal, 0, 32)

	// Library signals: favourites (5) and Watch Later (3).
	libRows, err := s.DB.QueryContext(ctx, `
SELECT canonical_id, media_kind, COALESCE(NULLIF(snapshot_title, ''), canonical_id),
       watch_later, favourite
FROM library_memberships
WHERE household_id = $1 AND (watch_later OR favourite)`, householdID)
	if err != nil {
		return nil, err
	}
	defer libRows.Close()
	for libRows.Next() {
		var canonicalID, mediaKind, title string
		var watchLater, favourite bool
		if err := libRows.Scan(&canonicalID, &mediaKind, &title, &watchLater, &favourite); err != nil {
			return nil, err
		}
		if favourite {
			signals = append(signals, Signal{CanonicalID: canonicalID, Kind: mediaKind, Label: "favourited", Weight: 5, Title: title})
		}
		if watchLater {
			signals = append(signals, Signal{CanonicalID: canonicalID, Kind: mediaKind, Label: "watch-later", Weight: 3, Title: title})
		}
	}
	if err := libRows.Err(); err != nil {
		return nil, err
	}

	// Progress signals: the LATEST watch_progress row per series — completed
	// (≥90%) becomes an exclusion marker (weight 0), watched (≥50%) a strong
	// signal, started (<50%) a weak one.
	progRows, err := s.DB.QueryContext(ctx, `
SELECT DISTINCT ON (series_id)
       series_id, percent, COALESCE(NULLIF(source_name, ''), series_id)
FROM watch_progress
ORDER BY series_id, updated_at DESC`)
	if err != nil {
		return nil, err
	}
	defer progRows.Close()
	for progRows.Next() {
		var seriesID string
		var percent float64
		var title string
		if err := progRows.Scan(&seriesID, &percent, &title); err != nil {
			return nil, err
		}
		switch {
		case percent >= 90:
			signals = append(signals, Signal{CanonicalID: seriesID, Label: "completed", Weight: 0, Title: title})
		case percent >= 50:
			signals = append(signals, Signal{CanonicalID: seriesID, Label: "watched", Weight: 4, Title: title})
		case percent > 0:
			signals = append(signals, Signal{CanonicalID: seriesID, Label: "started", Weight: 2, Title: title})
		}
	}
	if err := progRows.Err(); err != nil {
		return nil, err
	}

	// Visited signals (recent window only): title resolved from any library
	// snapshot when one exists.
	visitRows, err := s.DB.QueryContext(ctx, `
SELECT DISTINCT te.canonical_id, te.kind, COALESCE(NULLIF(lm.snapshot_title, ''), te.canonical_id)
FROM taste_events te
LEFT JOIN library_memberships lm
       ON lm.household_id = $1 AND lm.canonical_id = te.canonical_id
WHERE te.created_at > now() - interval '60 days'`, householdID)
	if err != nil {
		return nil, err
	}
	defer visitRows.Close()
	for visitRows.Next() {
		var canonicalID, kind, title string
		if err := visitRows.Scan(&canonicalID, &kind, &title); err != nil {
			return nil, err
		}
		signals = append(signals, Signal{CanonicalID: canonicalID, Kind: kind, Label: "opened", Weight: 1, Title: title})
	}
	if err := visitRows.Err(); err != nil {
		return nil, err
	}
	return signals, nil
}
