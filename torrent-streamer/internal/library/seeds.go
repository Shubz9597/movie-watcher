package library

import (
	"context"
	"time"
)

// Seed is one favourite title usable as a recommendation seed (M4.1). The
// snapshot title grounds the human-readable reason; the canonical id keeps
// the media-qualified identity.
type Seed struct {
	CanonicalID string
	Title       string
	AddedAt     time.Time
}

// FavouriteSeeds returns the up-to-limit most recently favourited canonical
// titles (contract: seeds = 20 most recent favourites).
func (s *Store) FavouriteSeeds(ctx context.Context, limit int) ([]Seed, error) {
	if limit <= 0 {
		return []Seed{}, nil
	}
	rows, err := s.DB.QueryContext(ctx, `
SELECT canonical_id, snapshot_title, favourite_added_at
FROM library_memberships
WHERE household_id=1 AND favourite AND favourite_added_at IS NOT NULL
ORDER BY favourite_added_at DESC, canonical_id ASC
LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	seeds := []Seed{}
	for rows.Next() {
		var seed Seed
		if err := rows.Scan(&seed.CanonicalID, &seed.Title, &seed.AddedAt); err != nil {
			return nil, err
		}
		seeds = append(seeds, seed)
	}
	return seeds, rows.Err()
}

// ActiveMembershipIDs returns every canonical id with ANY active collection
// membership (favourites ∪ watch-later) — the recommendation exclusion set.
func (s *Store) ActiveMembershipIDs(ctx context.Context) (map[string]bool, error) {
	rows, err := s.DB.QueryContext(ctx, `
SELECT canonical_id FROM library_memberships
WHERE household_id=1 AND (watch_later OR favourite)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids[id] = true
	}
	return ids, rows.Err()
}

// Revision returns the current household revision (recommendation cache key
// component: effective mutations invalidate, no-ops do not).
func (s *Store) Revision(ctx context.Context) (int64, error) {
	var revision int64
	err := s.DB.QueryRowContext(ctx, `SELECT revision FROM library_household WHERE id=1`).Scan(&revision)
	return revision, err
}

// MembershipEntry is the server-confirmed flag state of one requested title
// (repair pass: the per-title reconciliation source for cross-client sync).
type MembershipEntry struct {
	CanonicalID string `json:"canonicalId"`
	WatchLater  bool   `json:"watchLater"`
	Favourite   bool   `json:"favourite"`
}

// MembershipsFor returns the stored flag state for the requested canonical
// ids plus the household revision the answer was read at. Ids the server does
// NOT know are omitted — an omission read at revision R proves (for a client
// whose per-title state is older than R) that the title has no active
// membership, which is how a removal by ANOTHER client becomes visible
// without any client-local inference. Malformed ids are skipped; callers cap
// the batch (the handler enforces a limit).
func (s *Store) MembershipsFor(ctx context.Context, ids []string) ([]MembershipEntry, int64, error) {
	known := make([]string, 0, len(ids))
	for _, id := range ids {
		if err := ValidateCanonicalID(id); err == nil {
			known = append(known, id)
		}
	}
	revision, err := s.Revision(ctx)
	if err != nil {
		return nil, 0, err
	}
	if len(known) == 0 {
		return []MembershipEntry{}, revision, nil
	}
	rows, err := s.DB.QueryContext(ctx, `
SELECT canonical_id, watch_later, favourite FROM library_memberships
WHERE household_id=1 AND canonical_id = ANY($1)`, known)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	entries := []MembershipEntry{}
	for rows.Next() {
		var entry MembershipEntry
		if err := rows.Scan(&entry.CanonicalID, &entry.WatchLater, &entry.Favourite); err != nil {
			return nil, 0, err
		}
		entries = append(entries, entry)
	}
	return entries, revision, rows.Err()
}
