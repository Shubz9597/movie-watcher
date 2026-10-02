package search

import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

// Relevance audit (post-Prowlarr): every release is classified against the
// requested title and aliases BEFORE ranking, so seeder counts can never
// promote a wrong title, year, season, or episode.
//
//	classReject   — release evidence contradicts the request (wrong title,
//	               wrong year, explicit season/episode mismatch, pack that
//	               provably does not cover the request). Always dropped.
//	classAmbiguous — title matched but the release carries no verifiable
//	               evidence (no year, no parseable season/episode). Kept,
//	               but ranked strictly BELOW verified matches.
//	classVerified  — explicit release evidence confirms the request (release
//	               year equals the requested year; season/episode tokens
//	               match; a pack's actual coverage provably includes the
//	               requested episode).
type releaseClass int

const (
	classReject releaseClass = iota
	classAmbiguous
	classVerified
)

// releaseYearPattern matches scene-style year tokens. The LAST such token is
// the release year ("Movie.Name.2019.1080p"); earlier year-like tokens are
// usually part of the title ("Blade.Runner.2049.2017").
var releaseYearPattern = regexp.MustCompile(`\b(1[89]\d{2}|20\d{2})\b`)

// Sonarr-style decision: every parsed release is accepted or rejected against
// the request (exact title, season/episode coverage, quality, audio), and the
// accepted ones get the facts ranking needs.

// knownTitles holds the request's own title plus aliases as token sets.
// Base titles name this show; arc titles extend a base title with an arc or
// sequel name ("Kimetsu no Yaiba: Yuukaku-hen" next to "Kimetsu no Yaiba")
// and only count for later seasons.
type knownTitles struct {
	countries map[string]bool // US / UK tags the request's titles carry
	base      []map[string]bool
	arcs      []map[string]bool
	baseUnion map[string]bool
	allUnion  map[string]bool
	protected map[string]bool
}

type titleMatch int

const (
	titleNone titleMatch = iota
	titleArc
	titleBase
)

// arcWords mark a primary title as one arc of a franchise; its pre-colon
// prefix then names the whole franchise and must not become a base title.
var arcWords = map[string]bool{
	"arc": true, "hen": true, "season": true, "part": true, "movie": true, "film": true,
	"chapter": true, "saga": true, "cour": true,
}

func buildKnownTitles(request Request) knownTitles {
	known := knownTitles{
		baseUnion: map[string]bool{}, allUnion: map[string]bool{}, protected: map[string]bool{},
		countries: map[string]bool{},
	}
	type candidate struct {
		tokens           map[string]bool
		primary, derived bool
	}
	var candidates []candidate
	add := func(title string, primary, derived bool) {
		tokens := map[string]bool{}
		for _, word := range significantTokens(stripAnimeSeason(title)) {
			tokens[word] = true
		}
		for _, word := range strings.Fields(normalizeAnimeTitle(title)) {
			known.protected[word] = true
			if ignorableTitleTokens[word] {
				known.countries[word] = true
			}
		}
		if len(tokens) > 0 {
			candidates = append(candidates, candidate{tokens, primary, derived})
		}
	}
	add(request.Title, true, false)
	if prefix, ok := franchisePrefix(request.Title); ok {
		add(prefix, false, true)
	}
	for _, alias := range request.Aliases {
		add(alias, false, false)
	}
	// An alias is an arc when it extends another real title with words no
	// other title explains ("Kimetsu no Yaiba: Yuukaku-hen" next to "Kimetsu
	// no Yaiba"). "Demon Slayer: Kimetsu no Yaiba" next to "Demon Slayer" is
	// not: "Kimetsu no Yaiba" is itself a known title.
	isArc := func(index int) bool {
		current := candidates[index]
		if current.primary || current.derived {
			return false
		}
		for parentIndex, parent := range candidates {
			if parentIndex == index || parent.derived || len(parent.tokens) >= len(current.tokens) || !subsetOf(parent.tokens, current.tokens) {
				continue
			}
			// Only titles outside this parent's family can explain the extra
			// words; a second spelling of the same arc cannot vouch for it.
			explained := map[string]bool{}
			for otherIndex, other := range candidates {
				if otherIndex == index || other.derived || subsetOf(parent.tokens, other.tokens) {
					continue
				}
				for token := range other.tokens {
					explained[token] = true
				}
			}
			for token := range current.tokens {
				if !parent.tokens[token] && !explained[token] {
					return true
				}
			}
		}
		return false
	}
	for index, current := range candidates {
		for token := range current.tokens {
			known.allUnion[token] = true
		}
		if isArc(index) {
			known.arcs = append(known.arcs, current.tokens)
			continue
		}
		known.base = append(known.base, current.tokens)
		for token := range current.tokens {
			known.baseUnion[token] = true
		}
	}
	return known
}

// franchisePrefix returns "Demon Slayer" for "Demon Slayer: Kimetsu no Yaiba"
// unless the title itself names an arc ("... Entertainment District Arc").
func franchisePrefix(title string) (string, bool) {
	index := strings.IndexAny(title, ":")
	if dash := strings.Index(title, " - "); dash >= 0 && (index < 0 || dash < index) {
		index = dash
	}
	if index <= 0 {
		return "", false
	}
	for _, word := range strings.Fields(normalizeAnimeTitle(title)) {
		if arcWords[word] {
			return "", false
		}
	}
	return title[:index], true
}

func subsetOf(small, large map[string]bool) bool {
	for token := range small {
		if !large[token] {
			return false
		}
	}
	return true
}

func (known knownTitles) match(parsed parsedRelease) titleMatch {
	if len(parsed.titleTokens) == 0 {
		return titleNone
	}
	title := map[string]bool{}
	for _, token := range parsed.titleTokens {
		title[token] = true
	}
	withAlt := map[string]bool{}
	for token := range title {
		withAlt[token] = true
	}
	for _, token := range parsed.altTokens {
		withAlt[token] = true
	}
	covers := func(titles []map[string]bool) bool {
		for _, candidate := range titles {
			if subsetOf(candidate, withAlt) {
				return true
			}
		}
		return false
	}
	if subsetOf(title, known.baseUnion) && covers(known.base) {
		return titleBase
	}
	if subsetOf(title, known.allUnion) && covers(known.arcs) {
		return titleArc
	}
	return titleNone
}

type packKind int

const (
	packNone packKind = iota
	packEpisodeRange
	packSeason
	packMultiSeason
)

type releaseDecision struct {
	reject       bool
	class        releaseClass
	episodeMatch bool
	pack         packKind
	packReason   string
	languageRank int // 3 original audio, 2 untagged, 1 dual/multi or dub (anime), 0 rejected
	qualityTier  int // 0 good, 1 oversized or remux, 2 standard definition
	parsed       parsedRelease
}

func decideRelease(request Request, known knownTitles, release prowlarrRelease) releaseDecision {
	parsed := parseRelease(release.Title, known.protected)
	decision := releaseDecision{class: classAmbiguous, parsed: parsed}
	reject := func() releaseDecision { return releaseDecision{reject: true} }

	match := known.match(parsed)
	imdbMatch := normalizeIMDBID(string(release.ImdbID)) != "" && request.IMDBID != "" &&
		normalizeIMDBID(string(release.ImdbID)) == normalizeIMDBID(request.IMDBID)
	if match == titleNone && !imdbMatch {
		return reject()
	}
	if parsed.junk {
		return reject()
	}
	// "The Office UK" is a different show from "The Office (US)".
	for country := range parsed.countries {
		if len(known.countries) > 0 && !known.countries[country] {
			return reject()
		}
	}
	if request.Kind != KindAnime {
		// Anime indexers use language metadata for subtitles; elsewhere it
		// describes audio.
		for _, language := range release.Languages {
			if code := normalizeLanguage(language.Name); code != "" {
				parsed.audio[code] = true
			}
		}
	}
	rank, allowed := audioRank(request, parsed, release.Title)
	if !allowed {
		return reject()
	}
	decision.languageRank = rank
	decision.qualityTier = qualityTier(parsed, release.Size, request.Kind == KindMovie)

	if request.Kind == KindMovie {
		if len(parsed.seasonEpisodes) > 0 || len(parsed.seasons) > 0 {
			return reject() // a TV episode or season sharing the title
		}
		if parsed.year != 0 && request.Year > 0 {
			switch diff := parsed.year - request.Year; {
			case diff == 0:
				decision.class = classVerified
			case diff == 1 || diff == -1:
				// Festival vs. wide release years differ by one; keep it below
				// exact-year releases.
			default:
				return reject()
			}
		}
		return decision
	}

	if parsed.movie && len(parsed.seasonEpisodes) == 0 {
		return reject() // anime films are separate catalog entries
	}
	if match == titleArc && (request.Season == nil || *request.Season <= 1) {
		return reject() // a later arc never belongs to season 1
	}
	// A series year right after the title tells remakes apart.
	if parsed.titleYear != 0 && request.Year > 0 && (parsed.titleYear-request.Year > 1 || request.Year-parsed.titleYear > 1) {
		return reject()
	}
	return decideEpisode(request, parsed, match, decision)
}

func decideEpisode(request Request, parsed parsedRelease, match titleMatch, decision releaseDecision) releaseDecision {
	reject := releaseDecision{reject: true}
	season := 0
	if request.Season != nil {
		season = *request.Season
	}
	if season == 0 && request.Kind == KindAnime {
		season = 1
	}
	episode, target := 0, 0
	if request.Episode != nil {
		episode, target = *request.Episode, *request.Episode
	}
	if request.Absolute != nil {
		target = *request.Absolute
	}
	isTarget := func(value int) bool { return value > 0 && (value == target || value == episode) }
	// The app always sends an absolute number for anime; it only pins an
	// episode across seasons when it differs from the season's own number.
	absoluteDistinct := request.Absolute != nil && *request.Absolute != episode

	hasSeasons := len(parsed.seasons) > 0
	if hasSeasons && season > 0 && !parsed.seasons[season] {
		return reject
	}
	// Anime sequels name their season ("S2", "2nd Season"); an unmarked base
	// release is season 1, unless absolute numbering pins the episode.
	unmarkedLaterSeason := !hasSeasons && season > 1 && request.Kind == KindAnime && match == titleBase && !parsed.completeSeries

	if episode == 0 && request.Absolute == nil {
		// Title-level search: season evidence verifies.
		if unmarkedLaterSeason {
			return reject
		}
		if hasSeasons || parsed.completeSeries {
			decision.class = classVerified
		}
		decision.pack, decision.packReason = packFor(parsed)
		return decision
	}

	for _, pair := range parsed.seasonEpisodes {
		if (season == 0 || pair.season == season) && isTarget(pair.episode) {
			decision.class, decision.episodeMatch = classVerified, true
			return decision
		}
	}
	for _, span := range parsed.episodeRanges {
		if span.season != 0 && season != 0 && span.season != season {
			continue
		}
		if (target >= span.from && target <= span.to) || (episode >= span.from && episode <= span.to) {
			if unmarkedLaterSeason && !absoluteDistinct {
				return reject
			}
			decision.class, decision.episodeMatch = classVerified, true
			decision.pack, decision.packReason = packEpisodeRange, "episode-range"
			return decision
		}
	}
	if len(parsed.seasonEpisodes) > 0 || len(parsed.episodeRanges) > 0 {
		return reject // explicit episode evidence for other episodes
	}
	if len(parsed.absolutes) > 0 {
		if (parsed.pack || hasSeasons) && len(parsed.absolutes) == 2 && parsed.absolutes[0] < parsed.absolutes[1] {
			// "Batch (01 11)" / "S01 Ep (01 08)" with the dash stripped by
			// the indexer.
			if target >= parsed.absolutes[0] && target <= parsed.absolutes[1] {
				decision.class, decision.episodeMatch = classVerified, true
				decision.pack, decision.packReason = packEpisodeRange, "episode-range"
				return decision
			}
			return reject
		}
		for _, value := range parsed.absolutes {
			if isTarget(value) && !(unmarkedLaterSeason && !absoluteDistinct) {
				decision.class, decision.episodeMatch = classVerified, true
				return decision
			}
		}
		return reject
	}
	if unmarkedLaterSeason {
		return reject
	}
	// Season or series packs that cover the requested season.
	if (hasSeasons && parsed.seasons[season]) || parsed.completeSeries ||
		(parsed.pack && !hasSeasons && request.Kind == KindAnime && season == 1) {
		decision.class, decision.episodeMatch = classVerified, true
		decision.pack, decision.packReason = packFor(parsed)
		if decision.pack == packNone {
			decision.pack, decision.packReason = packSeason, "season-pack"
		}
		return decision
	}
	return decision // no evidence: ambiguous, dropped for episode requests
}

func packFor(parsed parsedRelease) (packKind, string) {
	switch {
	case parsed.completeSeries || len(parsed.seasons) > 1:
		return packMultiSeason, "complete-series"
	case len(parsed.seasons) == 1:
		return packSeason, "season-pack"
	case parsed.pack:
		return packSeason, "keyword"
	}
	return packNone, ""
}

// audioRank applies the language profile: anime accepts Japanese with
// subtitles (preferred), dual audio and English dubs; films and TV keep the
// original audio, allow dual audio that still carries it, and drop dubs.
func audioRank(request Request, parsed parsedRelease, fullName string) (int, bool) {
	if request.Kind == KindAnime {
		if cjkTitlePattern.MatchString(fullName) || parsed.chineseSubs {
			return 0, false
		}
		if parsed.raw && !parsed.subGroupHint {
			return 0, false
		}
		if parsed.foreignSubs && !parsed.subGroupHint {
			return 0, false // French / Portuguese / Spanish subtitle releases
		}
		for code := range parsed.audio {
			if code != "ja" && code != "en" {
				return 0, false // another language's dub
			}
		}
		if parsed.multiAudio || parsed.dubbed || parsed.audio["en"] {
			return 1, true
		}
		return 3, true
	}

	original := normalizeLanguage(request.OriginalLanguage)
	others := 0
	for code := range parsed.audio {
		if code != original {
			others++
		}
	}
	hasOriginal := original != "" && parsed.audio[original]
	switch {
	case parsed.dubbed && !(hasOriginal && (parsed.multiAudio || others > 0)):
		return 0, false
	case len(parsed.audio) == 0 && parsed.multiAudio:
		return 1, true
	case len(parsed.audio) == 0:
		return 2, true // untagged releases keep the original audio
	case original == "":
		if len(parsed.audio) == 1 {
			return 2, true
		}
		return 1, true
	case hasOriginal && others == 0 && !parsed.multiAudio:
		return 3, true
	case hasOriginal:
		return 1, true // dual audio that still carries the original
	case parsed.multiAudio && !parsed.dubbed:
		return 1, true // "MULTI VFF": a dub alongside the original track
	}
	return 0, false
}

const oversizedMovieBytes = 30 << 30

func qualityTier(parsed parsedRelease, size int64, movie bool) int {
	switch {
	case parsed.resolution > 0 && parsed.resolution < 720:
		return 2
	case parsed.resolution == 0 && parsed.source == "dvd":
		return 2
	case parsed.source == "remux":
		return 1
	case movie && size > oversizedMovieBytes:
		return 1
	}
	return 0
}

// seederScore is the swarm-health part of the sort: log-scaled so 900 vs
// 1000 seeders is a near tie that indexer trust can break.
func seederScore(seeders int) float64 {
	if seeders <= 0 {
		return 0
	}
	return math.Log2(float64(seeders) + 1)
}

var (
	sourceLabels = map[string]string{
		"remux": "REMUX", "bluray": "BluRay", "web-dl": "WEB-DL", "webrip": "WEBRip",
		"web": "WEB", "hdtv": "HDTV", "dvd": "DVD", "hdrip": "HDRip",
	}
	languageLabels = map[languageCode]string{
		"en": "English", "hi": "Hindi", "ja": "Japanese", "ta": "Tamil", "te": "Telugu",
		"ml": "Malayalam", "kn": "Kannada", "ko": "Korean", "fr": "French", "es": "Spanish",
		"de": "German", "it": "Italian", "ru": "Russian", "zh": "Chinese",
	}
	packLabels = map[packKind]string{
		packNone: "episode", packEpisodeRange: "range", packSeason: "season", packMultiSeason: "series",
	}
)

// applyBadges copies the parsed quality, audio and coverage onto a result.
func applyBadges(result *Result, request Request, decision releaseDecision) {
	parsed := decision.parsed
	if parsed.resolution > 0 {
		result.Quality = strconv.Itoa(parsed.resolution) + "p"
	}
	result.Source = sourceLabels[parsed.source]
	switch {
	case request.Kind == KindAnime && (parsed.dubbed || parsed.audio["en"]) && !parsed.multiAudio:
		result.Audio = "English dub"
	case parsed.multiAudio || len(parsed.audio) > 1:
		result.Audio = "Dual audio"
	case len(parsed.audio) == 1:
		for code := range parsed.audio {
			result.Audio = languageLabels[code]
		}
	}
	if request.Episode != nil || request.Absolute != nil || request.Season != nil {
		result.Pack = packLabels[decision.pack]
	}
}
