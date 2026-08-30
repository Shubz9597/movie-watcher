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
	Kind             Kind     `json:"kind"`
	Title            string   `json:"title"`
	Aliases          []string `json:"aliases,omitempty"`
	IMDBID           string   `json:"imdbId,omitempty"`
	TVDBID           int      `json:"tvdbId,omitempty"`
	Year             int      `json:"year,omitempty"`
	Season           *int     `json:"season,omitempty"`
	Episode          *int     `json:"episode,omitempty"`
	Absolute         *int     `json:"absolute,omitempty"`
	OriginalLanguage string   `json:"originalLanguage,omitempty"`
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
	Title        string      `json:"title"`
	Indexer      string      `json:"indexer"`
	Size         int64       `json:"size,omitempty"`
	Seeders      int         `json:"seeders,omitempty"`
	Leechers     int         `json:"leechers,omitempty"`
	MagnetURI    string      `json:"magnetUri,omitempty"`
	InfoHash     string      `json:"infoHash,omitempty"`
	SourceID     string      `json:"sourceId,omitempty"`
	PublishDate  string      `json:"publishDate,omitempty"`
	EpisodeMatch *bool       `json:"episodeMatch,omitempty"`
	SeasonPack   *SeasonPack `json:"seasonPack,omitempty"`
	languageRank int
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
