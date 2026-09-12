package library

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"time"

	"torrent-streamer/internal/catalog"
)

// CatalogResolver resolves metadata snapshots through the existing catalog
// service (one bounded detail call per write that needs one — reads never
// fan out to providers, so list/overview reads are N+1-free by construction).
type CatalogResolver struct {
	Catalog *catalog.Service
}

// Metadata is the snapshot a membership retains so an entry whose upstream
// metadata disappears stays renderable and removable (data-model.md).
type Metadata struct {
	Title   string
	Year    int
	Poster  string
	Kind    string // movie | series | anime
	SortKey string
}

// Resolve maps one canonical id onto the merged catalog detail. Returns
// catalog.ErrNotFound when the id is well-formed but unresolvable; other
// errors report degradation (never "not found").
func (r CatalogResolver) Resolve(ctx context.Context, canonicalID string) (Metadata, error) {
	result := r.Catalog.Detail(ctx, canonicalID)
	if !result.Found {
		if result.NotFound && len(result.DegradedProviders) == 0 {
			return Metadata{}, catalog.ErrNotFound
		}
		return Metadata{}, fmt.Errorf("%w: catalog providers degraded for %s", ErrUnavailable, canonicalID)
	}
	title := result.Title
	return Metadata{
		Title:   title.Title,
		Year:    title.Year,
		Poster:  title.Artwork["poster"],
		Kind:    string(title.Type),
		SortKey: catalog.NormalizeTitle(title.Title),
	}, nil
}

// Store is the SQL-backed household library (migrations/007).
type Store struct {
	DB       *sql.DB
	Resolver Resolver

	// Same-package test seams (nil in production). testHookAfterCount runs
	// between the count and page reads inside a snapshot so tests can prove
	// read consistency; testHookBeforeCommit fails a write transaction so
	// tests can prove no revision leaks on rollback.
	testHookAfterCount   func()
	testHookBeforeCommit func(tx *sql.Tx) error
}

// Resolver supplies metadata snapshots for canonical ids.
type Resolver interface {
	Resolve(ctx context.Context, canonicalID string) (Metadata, error)
}

// NewStore wraps an open database. Open validates that the library schema is
// actually initialized (migration 007 applied); callers must not advertise
// library.household.v1 when this fails (contract §Errors and negotiation).
func NewStore(ctx context.Context, db *sql.DB, resolver Resolver) (*Store, error) {
	store := &Store{DB: db, Resolver: resolver}
	var revision int64
	err := db.QueryRowContext(ctx, `SELECT revision FROM library_household WHERE id=1`).Scan(&revision)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, fmt.Errorf("library storage is not initialized (household row missing)")
		}
		return nil, fmt.Errorf("library storage is not available: %w", err)
	}
	return store, nil
}

// Write is one field-level membership update (contract §PUT).
type Write struct {
	CanonicalID string
	// Field is CollectionWatchLater or CollectionFavourites.
	Field   string
	Enabled bool
}

// WriteResult returns the committed server state: BOTH flags plus the
// post-commit household revision (lossless decimal string on the wire).
type WriteResult struct {
	CanonicalID string    `json:"canonicalId"`
	WatchLater  bool      `json:"watchLater"`
	Favourite   bool      `json:"favourite"`
	Revision    int64     `json:"-"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// RevisionString renders a revision as the lossless decimal wire format.
func RevisionString(revision int64) string { return strconv.FormatInt(revision, 10) }

type membershipRow struct {
	id                int64
	canonicalID       string
	mediaKind         string
	watchLater        bool
	favourite         bool
	watchLaterAdded   sql.NullTime
	favouriteAdded    sql.NullTime
	metadataAvailable bool
	snapshotTitle     string
	snapshotYear      sql.NullInt64
	snapshotPoster    sql.NullString
	sortKey           string
	updatedAt         time.Time
}

const membershipColumns = `
  id, canonical_id, media_kind, watch_later, favourite,
  watch_later_added_at, favourite_added_at, metadata_available,
  snapshot_title, snapshot_year, snapshot_poster, sort_key, updated_at`

func scanMembership(row interface{ Scan(...any) error }) (membershipRow, error) {
	var m membershipRow
	err := row.Scan(
		&m.id, &m.canonicalID, &m.mediaKind, &m.watchLater, &m.favourite,
		&m.watchLaterAdded, &m.favouriteAdded, &m.metadataAvailable,
		&m.snapshotTitle, &m.snapshotYear, &m.snapshotPoster, &m.sortKey, &m.updatedAt,
	)
	return m, err
}

// Write applies one flag update transactionally (data-model.md §Transactions):
// serialize through the household revision row, get-or-create the unique
// membership, update only the requested flag, and advance the revision only
// for an effective change. No-op/retry writes return committed state without
// bumping the revision or reordering a collection. An existing membership
// whose metadata became unavailable is preserved and labelled; only its
// snapshot renders it.
func (s *Store) Write(ctx context.Context, write Write) (WriteResult, error) {
	if write.Field != CollectionWatchLater && write.Field != CollectionFavourites {
		return WriteResult{}, fmt.Errorf("%w: field must be %q or %q", ErrInvalidRequest, CollectionWatchLater, CollectionFavourites)
	}
	if err := ValidateCanonicalID(write.CanonicalID); err != nil {
		return WriteResult{}, err
	}

	existing, err := s.readMembership(ctx, write.CanonicalID)
	if err != nil {
		return WriteResult{}, err
	}
	hasExisting := existing != nil

	// Resolve BEFORE taking the household lock: memberships need at most one
	// metadata call, and holding the serialization lock across a provider
	// call would stall unrelated writes. A resolvable title refreshes the
	// snapshot; an unresolvable one never erases a stored snapshot.
	var meta Metadata
	var resolved, missing bool
	{
		if s.Resolver == nil {
			if !hasExisting {
				return WriteResult{}, fmt.Errorf("%w: no metadata resolver configured", ErrUnavailable)
			}
		} else {
			meta, err = s.Resolver.Resolve(ctx, write.CanonicalID)
			switch {
			case errors.Is(err, catalog.ErrNotFound):
				if !hasExisting {
					return WriteResult{}, ErrTitleNotFound
				}
				missing = true
			case err != nil:
				if !hasExisting {
					return WriteResult{}, err
				}
				// Existing membership: a degraded refresh never blocks the
				// write; the stored snapshot keeps the entry renderable.
			default:
				resolved = true
				if meta.Kind != KindMovie && meta.Kind != KindSeries && meta.Kind != KindAnime {
					return WriteResult{}, fmt.Errorf("%w: resolver returned unknown kind %q", ErrInvalidRequest, meta.Kind)
				}
			}
		}
	}

	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return WriteResult{}, fmt.Errorf("begin library transaction: %w", err)
	}
	defer tx.Rollback()

	// Serialize every effective change through the single household row.
	var revision int64
	if err := tx.QueryRowContext(ctx,
		`SELECT revision FROM library_household WHERE id=1 FOR UPDATE`).Scan(&revision); err != nil {
		return WriteResult{}, fmt.Errorf("lock household revision: %w", err)
	}

	// Get-or-create under the lock (concurrent first writers serialize here;
	// the unique constraint arbitrates the insert).
	if !hasExisting {
		year, poster := nullInt64(meta.Year), nullString(meta.Poster)
		if _, err := tx.ExecContext(ctx, `
INSERT INTO library_memberships
  (household_id, canonical_id, media_kind, metadata_available, snapshot_title, snapshot_year, snapshot_poster, sort_key)
VALUES (1, $1, $2, TRUE, $3, $4, $5, $6)
ON CONFLICT (household_id, canonical_id) DO NOTHING`,
			write.CanonicalID, meta.Kind, meta.Title, year, poster, meta.SortKey); err != nil {
			return WriteResult{}, fmt.Errorf("create membership: %w", err)
		}
	} else if resolved {
		year, poster := nullInt64(meta.Year), nullString(meta.Poster)
		if _, err := tx.ExecContext(ctx, `
UPDATE library_memberships SET
  media_kind=$2, metadata_available=TRUE, snapshot_title=$3, snapshot_year=$4, snapshot_poster=$5, sort_key=$6
WHERE household_id=1 AND canonical_id=$1`,
			write.CanonicalID, meta.Kind, meta.Title, year, poster, meta.SortKey); err != nil {
			return WriteResult{}, fmt.Errorf("refresh membership snapshot: %w", err)
		}
	} else if missing {
		if _, err := tx.ExecContext(ctx, `
UPDATE library_memberships SET metadata_available=FALSE
WHERE household_id=1 AND canonical_id=$1`, write.CanonicalID); err != nil {
			return WriteResult{}, fmt.Errorf("mark metadata unavailable: %w", err)
		}
	}

	current, err := scanMembership(tx.QueryRowContext(ctx,
		`SELECT `+membershipColumns+` FROM library_memberships WHERE household_id=1 AND canonical_id=$1 FOR UPDATE`,
		write.CanonicalID))
	if err != nil {
		return WriteResult{}, fmt.Errorf("lock membership: %w", err)
	}

	result := WriteResult{
		CanonicalID: write.CanonicalID,
		WatchLater:  current.watchLater,
		Favourite:   current.favourite,
		Revision:    revision,
		UpdatedAt:   current.updatedAt,
	}
	currentValue := current.watchLater
	if write.Field == CollectionFavourites {
		currentValue = current.favourite
	}
	if currentValue == write.Enabled {
		// No-op / retried write: committed state, unchanged revision, no
		// reorder, AND no metadata refresh — a no-op must not touch anything
		// the revision semantics depend on (mutation_revision, added
		// timestamps, household revision). The stored snapshot stays exactly
		// as the last effective write left it.
		if err := tx.Commit(); err != nil {
			return WriteResult{}, fmt.Errorf("commit library transaction: %w", err)
		}
		return result, nil
	}

	// Effective change: set/clear only this collection's timestamp, advance
	// the household revision, and record the mutation revision.
	newRevision := revision + 1
	column, addedColumn := "watch_later", "watch_later_added_at"
	if write.Field == CollectionFavourites {
		column, addedColumn = "favourite", "favourite_added_at"
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE library_memberships SET
  `+column+`=$2,
  `+addedColumn+`=CASE WHEN $2 THEN now() ELSE NULL END,
  mutation_revision=$3
WHERE household_id=1 AND canonical_id=$1`, write.CanonicalID, write.Enabled, newRevision); err != nil {
		return WriteResult{}, fmt.Errorf("update membership flag: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE library_household SET revision=$1, updated_at=now() WHERE id=1`, newRevision); err != nil {
		return WriteResult{}, fmt.Errorf("advance household revision: %w", err)
	}

	if s.testHookBeforeCommit != nil {
		if err := s.testHookBeforeCommit(tx); err != nil {
			return WriteResult{}, err // deferred Rollback: no leaked revision
		}
	}

	if err := tx.Commit(); err != nil {
		return WriteResult{}, fmt.Errorf("commit library transaction: %w", err)
	}
	if write.Field == CollectionWatchLater {
		result.WatchLater = write.Enabled
	} else {
		result.Favourite = write.Enabled
	}
	result.Revision = newRevision
	// The updated_at the client sees is the committed row time (the update
	// trigger refreshed it inside the committed transaction).
	if refreshed, err := s.readMembership(ctx, write.CanonicalID); err == nil && refreshed != nil {
		result.UpdatedAt = refreshed.updatedAt
	}
	return result, nil
}

func (s *Store) readMembership(ctx context.Context, canonicalID string) (*membershipRow, error) {
	row, err := scanMembership(s.DB.QueryRowContext(ctx,
		`SELECT `+membershipColumns+` FROM library_memberships WHERE household_id=1 AND canonical_id=$1`,
		canonicalID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read membership: %w", err)
	}
	return &row, nil
}

func nullInt64(value int) any {
	if value == 0 {
		return nil
	}
	return value
}

func nullString(value string) any {
	if value == "" {
		return nil
	}
	return value
}
