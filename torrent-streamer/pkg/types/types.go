package types

type Candidate struct {
	InfoHash      string
	Magnet        string
	Title         string
	ReleaseGroup  string
	Resolution    string // "2160p","1080p","720p","480p"
	Codec         string // "h264","hevc","av1","hi10p",...
	Source        string // "WEB-DL","WEBRip","HDTV","BluRay",...
	Seeders       int
	Leechers      int
	SizeBytes     int64
	FileIndex     *int
	SourceKind    string // "single"|"season_pack"
	ParsedSeason  int
	ParsedEpisode int
	AbsEpisode    *int // for anime (optional)
}

type ScoreBreakdown struct {
	Health, Quality, Size, Consistency float64
	HardReject                         string
	Total                              float64
}

type Pick struct {
	SeriesID     string
	Season       int
	Episode      int
	ProfileHash  string
	InfoHash     string
	Magnet       string
	ReleaseGroup *string
	Resolution   string
	Codec        string
	FileIndex    *int
	SourceKind   string
	SizeBytes    *int64
	Score        ScoreBreakdown
}
