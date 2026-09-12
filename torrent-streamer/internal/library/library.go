// Package library implements the household library persistence and service
// rules finalized in specs/002-mobile-shared-ui/data-model.md and
// contracts/library-api.md (feature 002 M3.2). One household scope per
// deployment; independent Watch Later / Favourite booleans per canonical
// catalog title; transactionally serialized revisions returned as lossless
// decimal strings. Watch progress (internal/watch) is untouched.
package library

import (
	"errors"
	"fmt"
	"regexp"
)

// Capability advertised through /v1/version ONLY when the storage schema is
// initialized and the full handler contract is wired (contracts/library-api.md
// §Errors and negotiation). Old servers do not serve it; clients must treat
// its absence as an explicit library-unavailable state.
const Capability = "library.household.v1"

// Collection identifiers (contract §GET /v2/library).
const (
	CollectionWatchLater = "watch-later"
	CollectionFavourites = "favourites"
)

// Media kinds: the canonical catalog classification. Anime is a
// classification over the structural movie/TV identity, never a separate id
// namespace — a TMDb anime keeps its qualified tmdb:tv:N id.
const (
	KindMovie  = "movie"
	KindSeries = "series"
	KindAnime  = "anime"
	KindAll    = "all"
)

// Sort orders (contract §Ordering).
const (
	SortRecent = "recent"
	SortTitle  = "title"
)

// Sentinel errors mapped to the versioned error envelope by the HTTP layer.
var (
	// ErrInvalidRequest covers malformed ids, fields, query parameters and
	// scope-mismatched cursors (HTTP 400 invalid_request). This includes the
	// unqualified legacy alias tmdb:N, which is never a valid library key.
	ErrInvalidRequest = errors.New("library: invalid request")
	// ErrTitleNotFound covers a well-formed canonical id that no provider can
	// resolve AND that has no stored membership snapshot (HTTP 404).
	ErrTitleNotFound = errors.New("library: title not found")
	// ErrUnavailable reports upstream metadata fan-out failure on a write
	// that needed a first resolution (HTTP 503 providers_unavailable).
	ErrUnavailable = errors.New("library: metadata unavailable")
)

var canonicalIDPattern = regexp.MustCompile(`^(?:(?:tmdb:(?:movie|tv)|anilist|jikan):\d+|imdb:tt\d+)$`)

// ValidateCanonicalID accepts only canonical qualified ids. The legacy
// unqualified `tmdb:N` form is a read alias in the catalog and is NEVER a
// valid library write key (contract §Identity).
func ValidateCanonicalID(id string) error {
	if !canonicalIDPattern.MatchString(id) {
		return fmt.Errorf("%w: %q is not a canonical media-qualified catalog id", ErrInvalidRequest, id)
	}
	return nil
}

// ValidateQuery normalizes and validates list/overview query parameters.
// collection is required; kind defaults to all; sort defaults to recent.
func ValidateQuery(collection, kind, sort string) (normalizedCollection, normalizedKind, normalizedSort string, err error) {
	switch collection {
	case CollectionWatchLater, CollectionFavourites:
		normalizedCollection = collection
	default:
		return "", "", "", fmt.Errorf("%w: collection must be %q or %q", ErrInvalidRequest, CollectionWatchLater, CollectionFavourites)
	}
	switch kind {
	case "":
		normalizedKind = KindAll
	case KindAll, KindMovie, KindSeries, KindAnime:
		normalizedKind = kind
	default:
		return "", "", "", fmt.Errorf("%w: kind must be all, movie, series, or anime", ErrInvalidRequest)
	}
	switch sort {
	case "":
		normalizedSort = SortRecent
	case SortRecent, SortTitle:
		normalizedSort = sort
	default:
		return "", "", "", fmt.Errorf("%w: sort must be recent or title", ErrInvalidRequest)
	}
	return normalizedCollection, normalizedKind, normalizedSort, nil
}
