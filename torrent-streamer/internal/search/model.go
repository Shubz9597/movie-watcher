// Package search owns torrent indexer searches and source resolution.
package search

// Kind identifies the Prowlarr search strategy.
type Kind string

const (
	KindMovie Kind = "movie"
	KindTV    Kind = "tv"
	KindAnime Kind = "anime"
)

// Request describes a torrent search.
type Request struct {
	Kind    Kind     `json:"kind"`
	Title   string   `json:"title"`
	Aliases []string `json:"aliases,omitempty"`
	IMDBID  string   `json:"imdbId,omitempty"`
	// AniListID identifies anime for Torrentio (resolved to a Kitsu id).
	AniListID        int    `json:"anilistId,omitempty"`
	TVDBID           int    `json:"tvdbId,omitempty"`
	Year             int    `json:"year,omitempty"`
	Season           *int   `json:"season,omitempty"`
	Episode          *int   `json:"episode,omitempty"`
	Absolute         *int   `json:"absolute,omitempty"`
	OriginalLanguage string `json:"originalLanguage,omitempty"`
}

// SeasonPack describes why a release is considered a multi-episode pack.
type SeasonPack struct {
	Season   *int     `json:"season,omitempty"`
	Reason   string   `json:"reason,omitempty"`
	Keywords []string `json:"keywords,omitempty"`
}

// Result is a renderer-safe torrent search result. SourceID is opaque: raw
// indexer download URLs and credentials never cross the backend boundary.
type Result struct {
	Title       string `json:"title"`
	Indexer     string `json:"indexer"`
	Size        int64  `json:"size,omitempty"`
	Seeders     int    `json:"seeders,omitempty"`
	Leechers    int    `json:"leechers,omitempty"`
	MagnetURI   string `json:"magnetUri,omitempty"`
	InfoHash    string `json:"infoHash,omitempty"`
	SourceID    string `json:"sourceId,omitempty"`
	PublishDate string `json:"publishDate,omitempty"`
	// FileIndex is the requested episode's file inside a pack, when the
	// source knows it.
	FileIndex    *int        `json:"fileIndex,omitempty"`
	EpisodeMatch *bool       `json:"episodeMatch,omitempty"`
	SeasonPack   *SeasonPack `json:"seasonPack,omitempty"`
	// Badges parsed from the release name: "1080p", "BluRay", "Hindi" /
	// "Dual audio" / "English dub", and "episode" | "range" | "season" |
	// "series" for what the torrent covers.
	Quality string `json:"quality,omitempty"`
	Source  string `json:"source,omitempty"`
	Audio   string `json:"audio,omitempty"`
	Pack    string `json:"pack,omitempty"`

	// Ranking inputs (unexported). verified: explicit release evidence
	// (year/season/episode/pack coverage) confirmed the request.
	languageRank int
	verified     bool
	packTier     int
	qualityTier  int
}

// Response contains ranked search results.
type Response struct {
	Query   Request  `json:"query"`
	Total   int      `json:"total"`
	Results []Result `json:"results"`
}

// ResolveRequest identifies a source selected by the user.
type ResolveRequest struct {
	SourceID string `json:"sourceId,omitempty"`
	Magnet   string `json:"magnetUri,omitempty"`
	InfoHash string `json:"infoHash,omitempty"`
}

// ResolveResult is the playable source returned for a selection.
type ResolveResult struct {
	MagnetURI string `json:"magnetUri"`
	InfoHash  string `json:"infoHash,omitempty"`
}
