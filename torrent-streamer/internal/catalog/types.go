package catalog

import (
	"fmt"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// TitleType is the catalog type of a work (data-model.md Title.type).
type TitleType string

const (
	TypeMovie  TitleType = "movie"
	TypeSeries TitleType = "series"
	TypeAnime  TitleType = "anime"
)

// Title is the merged, provider-opaque catalog entity (data-model.md Title).
type Title struct {
	ID            string            `json:"id"`
	Type          TitleType         `json:"type"`
	Title         string            `json:"title"`
	OriginalTitle string            `json:"originalTitle,omitempty"`
	Year          int               `json:"year,omitempty"`
	Overview      string            `json:"overview"`
	Artwork       map[string]string `json:"artwork,omitempty"`
	ProviderIDs   map[string]string `json:"providerIds"`
	IMDBID        string            `json:"imdbId,omitempty"`
	MergedFrom    []string          `json:"mergedFrom"`
	// Format is the provider's release format (tv, movie, ova, ona,
	// special, tv_short, music); Popularity its relative audience size.
	// Search uses both to label and order franchise entries.
	Format     string  `json:"format,omitempty"`
	Popularity float64 `json:"popularity,omitempty"`

	// Detail-only enrichment (contracts/v2-catalog-api.md §title detail).
	Runtime       int               `json:"runtime,omitempty"`
	Genres        []string          `json:"genres,omitempty"`
	ExternalLinks map[string]string `json:"externalLinks,omitempty"`
	Seasons       []Season          `json:"seasons,omitempty"`
	// Alternative titles (romaji/native for anime, AKA titles elsewhere).
	// Torrent search fans out over these: indexers index release names under
	// the ORIGINAL/romaji title, not the localized display title.
	AltTitles []string `json:"altTitles,omitempty"`
	// Series places one AniList entry (an arc or cour) inside the TMDb show
	// that groups the whole franchise, so clients can open that show instead.
	Series *SeriesLink `json:"series,omitempty"`
	// Anime marks a show or film listed in the community anime list (it is
	// otherwise typed by its catalog: a TMDb show stays "series").
	Anime bool `json:"anime,omitempty"`
}

// SeriesLink is a season of a grouped TMDb show: the entry's episode N is the
// show's episode N+EpisodeOffset of Season.
type SeriesLink struct {
	ID            string `json:"id"`
	Season        int    `json:"season"`
	EpisodeOffset int    `json:"episodeOffset,omitempty"`
	// Absolute: the entry spans several of the show's seasons (One Piece);
	// its episode N is the show's Nth regular episode, not one season's.
	Absolute bool `json:"absolute,omitempty"`
	// episodes is the entry's episode count, checked against the show.
	episodes int
}

// Season summarizes one season of a series/anime title. TMDb supplies the
// per-season list for tv; anime providers surface a single season with the
// known episode count so clients can render episode skeletons without
// provider calls (T042.1).
type Season struct {
	Number       int    `json:"number"`
	Name         string `json:"name,omitempty"`
	EpisodeCount int    `json:"episodeCount,omitempty"`
	AirDate      string `json:"airDate,omitempty"`
	Poster       string `json:"poster,omitempty"`
}

// Episode is a playable unit of a series/anime title (data-model.md Episode).
// The owning title is implied by the request path and never serialized.
type Episode struct {
	ID        string `json:"id"`
	TitleID   string `json:"-"`
	Season    int    `json:"season"`
	Episode   int    `json:"episode"`
	Title     string `json:"title"`
	AirDate   string `json:"airDate,omitempty"`
	Still     string `json:"still,omitempty"`
	Overview  string `json:"overview,omitempty"`
	DurationS int    `json:"duration_s,omitempty"`
	// Absolute is the episode's place among all of the show's regular
	// episodes (anime releases are often numbered this way); 0 for specials.
	Absolute    int               `json:"absolute,omitempty"`
	ProviderIDs map[string]string `json:"providerIds"`
}

// ParseTitleID splits an opaque namespaced identifier ("tmdb:209867").
func ParseTitleID(id string) (provider, externalID string, err error) {
	provider, externalID, ok := strings.Cut(id, ":")
	if !ok || provider == "" || externalID == "" {
		return "", "", fmt.Errorf("invalid catalog id %q: expected provider:externalId", id)
	}
	return provider, externalID, nil
}

// NormalizeTitle mirrors the characterized renderer merge key
// (electron-app/src/lib/anime-catalog.ts normalizeAnimeTitle): NFKD,
// lowercase, strip season/part/cour markers, collapse non-alphanumerics.
func NormalizeTitle(title string) string {
	decomposed := norm.NFKD.String(strings.ToLower(title))
	var builder strings.Builder
	for _, r := range decomposed {
		if !unicode.Is(unicode.Mn, r) {
			builder.WriteRune(r)
		}
	}
	cleaned := seasonPartMarker.ReplaceAllString(builder.String(), " ")
	cleaned = nonAlphanumeric.ReplaceAllString(cleaned, " ")
	return strings.TrimSpace(cleaned)
}
