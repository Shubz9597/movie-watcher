package library

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// cursor is the opaque, scope-bound pagination token (contract: cursors embed
// collection + kind + sort + last tuple; a cursor presented with a mismatched
// scope is invalid_request, never silently mixed scopes).
type cursor struct {
	Collection string `json:"collection"`
	Kind       string `json:"kind"`
	Sort       string `json:"sort"`
	Last       struct {
		Value string `json:"v"` // recent: added timestamp (RFC3339Nano); title: sort key
		ID    string `json:"id"`
	} `json:"last"`
}

func encodeCursor(c cursor) string {
	raw, _ := json.Marshal(c)
	return base64.RawURLEncoding.EncodeToString(raw)
}

func decodeCursor(encoded string) (cursor, error) {
	var c cursor
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return c, fmt.Errorf("%w: cursor is not a valid token", ErrInvalidRequest)
	}
	if err := json.Unmarshal(raw, &c); err != nil {
		return c, fmt.Errorf("%w: cursor is not a valid token", ErrInvalidRequest)
	}
	return c, nil
}

// Item is one canonical library summary (contract response shape).
type Item struct {
	CanonicalID       string            `json:"canonicalId"`
	Type              string            `json:"type"`
	Title             string            `json:"title"`
	Year              int               `json:"year,omitempty"`
	Artwork           map[string]string `json:"artwork,omitempty"`
	AddedAt           time.Time         `json:"addedAt"`
	MetadataAvailable bool              `json:"metadataAvailable"`
}

// Page is one scope-bound page of a collection grid.
type Page struct {
	Collection string
	Kind       string
	Sort       string
	Revision   int64
	Total      int
	Items      []Item
	NextCursor string // "" on the last page
}

// Shelf is one media-kind group of the batched overview read.
type Shelf struct {
	Kind     string
	Count    int
	Previews []Item
}

// Overview is the consistent batched shelf snapshot (contract
// §GET /v2/library/overview): counts, previews and revision all come from one
// read snapshot.
type Overview struct {
	Collection string
	Sort       string
	Revision   int64
	SourceRev  int64
	Shelves    []Shelf
}

const defaultLimit = 30
const maxLimit = 100
const previewLimit = 6

// Page reads one page of a collection grid inside a repeatable-read snapshot
// so the returned revision, full-scope total and items are mutually
// consistent even when a write commits between the count and the page read
// (data-model.md §Reads, sorting and cursors).
func (s *Store) Page(ctx context.Context, collection, kind, sort, cursorToken string, limit int) (Page, error) {
	collection, kind, sort, err := ValidateQuery(collection, kind, sort)
	if err != nil {
		return Page{}, err
	}
	if limit <= 0 {
		limit = defaultLimit
	}
	if limit > maxLimit {
		limit = maxLimit
	}
	column, order := sortColumns(collection, sort)

	var last cursor
	if cursorToken != "" {
		last, err = decodeCursor(cursorToken)
		if err != nil {
			return Page{}, err
		}
		if last.Collection != collection || last.Kind != kind || last.Sort != sort {
			return Page{}, fmt.Errorf("%w: cursor does not match the requested collection/kind/sort", ErrInvalidRequest)
		}
	}

	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead})
	if err != nil {
		return Page{}, fmt.Errorf("begin library snapshot: %w", err)
	}
	defer tx.Rollback()

	var revision int64
	if err := tx.QueryRowContext(ctx, `SELECT revision FROM library_household WHERE id=1`).Scan(&revision); err != nil {
		return Page{}, fmt.Errorf("read household revision: %w", err)
	}

	where, args := collectionWhere(collection, kind)
	var total int
	if err := tx.QueryRowContext(ctx,
		`SELECT count(*) FROM library_memberships WHERE `+where, args...).Scan(&total); err != nil {
		return Page{}, fmt.Errorf("count collection: %w", err)
	}
	if s.testHookAfterCount != nil {
		s.testHookAfterCount()
	}

	// Fetch one extra row to decide whether a next page exists.
	pageWhere, pageArgs := where, args
	if cursorToken != "" {
		pageWhere += " AND " + keysetCondition(column, order, len(args)+1)
		pageArgs = append(append([]any{}, args...), last.Last.Value, last.Last.ID)
	}
	rows, err := tx.QueryContext(ctx, `
SELECT `+membershipColumns+` FROM library_memberships WHERE `+pageWhere+`
ORDER BY `+order+` LIMIT $`+strconv.Itoa(len(pageArgs)+1), append(pageArgs, limit+1)...)
	if err != nil {
		return Page{}, fmt.Errorf("read collection page: %w", err)
	}
	defer rows.Close()

	page := Page{Collection: collection, Kind: kind, Sort: sort, Revision: revision, Total: total}
	var lastIncluded membershipRow
	for rows.Next() {
		row, err := scanMembership(rows)
		if err != nil {
			return Page{}, fmt.Errorf("scan membership: %w", err)
		}
		if len(page.Items) < limit {
			page.Items = append(page.Items, itemFrom(row, collection))
			lastIncluded = row
		} else {
			// One extra row exists: the client saw the page's last row, so
			// the cursor continues after THAT tuple.
			page.NextCursor = encodeCursor(cursorOf(column, lastIncluded, collection, kind, sort))
		}
	}
	if err := rows.Err(); err != nil {
		return Page{}, fmt.Errorf("iterate collection page: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return Page{}, fmt.Errorf("commit library snapshot: %w", err)
	}
	return page, nil
}

// Overview reads the batched shelf snapshot: every count and preview comes
// from the same repeatable-read snapshot as the returned revision.
func (s *Store) Overview(ctx context.Context, collection, sort string) (Overview, error) {
	collection, _, sort, err := ValidateQuery(collection, KindAll, sort)
	if err != nil {
		return Overview{}, err
	}
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead})
	if err != nil {
		return Overview{}, fmt.Errorf("begin library snapshot: %w", err)
	}
	defer tx.Rollback()

	var revision int64
	if err := tx.QueryRowContext(ctx, `SELECT revision FROM library_household WHERE id=1`).Scan(&revision); err != nil {
		return Overview{}, fmt.Errorf("read household revision: %w", err)
	}

	overview := Overview{Collection: collection, Sort: sort, Revision: revision, SourceRev: revision}
	for _, kind := range []string{KindMovie, KindSeries, KindAnime} {
		shelf := Shelf{Kind: kind, Previews: []Item{}}
		where, args := collectionWhere(collection, kind)
		if err := tx.QueryRowContext(ctx,
			`SELECT count(*) FROM library_memberships WHERE `+where, args...).Scan(&shelf.Count); err != nil {
			return Overview{}, fmt.Errorf("count shelf %s: %w", kind, err)
		}
		_, order := sortColumns(collection, sort)
		rows, err := tx.QueryContext(ctx, `
SELECT `+membershipColumns+` FROM library_memberships WHERE `+where+`
ORDER BY `+order+` LIMIT `+strconv.Itoa(previewLimit), args...)
		if err != nil {
			return Overview{}, fmt.Errorf("read shelf previews %s: %w", kind, err)
		}
		for rows.Next() {
			row, err := scanMembership(rows)
			if err != nil {
				rows.Close()
				return Overview{}, fmt.Errorf("scan membership: %w", err)
			}
			shelf.Previews = append(shelf.Previews, itemFrom(row, collection))
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return Overview{}, fmt.Errorf("iterate shelf previews %s: %w", kind, err)
		}
		rows.Close()
		overview.Shelves = append(overview.Shelves, shelf)
	}
	if err := tx.Commit(); err != nil {
		return Overview{}, fmt.Errorf("commit library snapshot: %w", err)
	}
	return overview, nil
}

// collectionWhere builds the active-membership filter for one collection and
// kind. args starts with $1 = household id.
func collectionWhere(collection, kind string) (string, []any) {
	flagColumn := "watch_later"
	if collection == CollectionFavourites {
		flagColumn = "favourite"
	}
	where := "household_id=$1 AND " + flagColumn
	args := []any{1}
	if kind != KindAll {
		args = append(args, kind)
		where += fmt.Sprintf(" AND media_kind=$%d", len(args))
	}
	return where, args
}

// sortColumns returns (value column, ORDER BY clause) for the requested sort.
// Recent: collection-specific added time DESC, then canonical id ASC.
// Title: normalized sort key ASC, then canonical id ASC.
func sortColumns(collection, sort string) (column, orderBy string) {
	addedColumn := "watch_later_added_at"
	if collection == CollectionFavourites {
		addedColumn = "favourite_added_at"
	}
	if sort == SortTitle {
		return "sort_key", "sort_key ASC, canonical_id ASC"
	}
	return addedColumn, addedColumn + " DESC NULLS LAST, canonical_id ASC"
}

// keysetCondition continues one keyset page after the last tuple; value and
// id bind at the given placeholder numbers. Mixed direction (recent: value
// DESC + id ASC) needs an explicit OR; the all-ascending title order uses a
// row comparison.
func keysetCondition(column, order string, valuePlaceholder int) string {
	id := valuePlaceholder + 1
	v := strconv.Itoa(valuePlaceholder)
	if strings.HasPrefix(order, "sort_key") {
		return fmt.Sprintf("ROW(%s, canonical_id) > (ROW($%s, $%d))", column, v, id)
	}
	// DESC value column, ASC id: rows after the last one have a smaller
	// timestamp, or an equal timestamp with a greater canonical id.
	return fmt.Sprintf("(%s < $%s OR (%s = $%s AND canonical_id > $%d))", column, v, column, v, id)
}

// cursorOf builds the scope-bound token from the last tuple the client saw.
func cursorOf(column string, row membershipRow, collection, kind, sort string) cursor {
	var c cursor
	c.Collection, c.Kind, c.Sort = collection, kind, sort
	c.Last.ID = row.canonicalID
	if column == "sort_key" {
		c.Last.Value = row.sortKey
	} else {
		value := row.watchLaterAdded
		if column == "favourite_added_at" {
			value = row.favouriteAdded
		}
		if value.Valid {
			c.Last.Value = value.Time.UTC().Format(time.RFC3339Nano)
		}
	}
	return c
}

// itemFrom maps a stored membership row onto the contract item shape using
// ONLY stored snapshot columns (no provider calls; N+1-free reads).
func itemFrom(row membershipRow, collection string) Item {
	item := Item{
		CanonicalID:       row.canonicalID,
		Type:              row.mediaKind,
		Title:             row.snapshotTitle,
		AddedAt:           time.Time{},
		MetadataAvailable: row.metadataAvailable,
	}
	if row.snapshotYear.Valid {
		item.Year = int(row.snapshotYear.Int64)
	}
	if row.snapshotPoster.Valid && row.snapshotPoster.String != "" {
		item.Artwork = map[string]string{"poster": row.snapshotPoster.String}
	}
	added := row.watchLaterAdded
	if collection == CollectionFavourites {
		added = row.favouriteAdded
	}
	if added.Valid {
		item.AddedAt = added.Time
	}
	return item
}
