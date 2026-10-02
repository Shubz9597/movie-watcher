package search

import (
	"regexp"
	"strconv"
	"strings"
)

// parsedRelease is what one release name says about itself, in the spirit of
// Sonarr's parser: which title it claims, which seasons/episodes it covers,
// and its quality and audio. Matching against a request happens in decide.go.
type parsedRelease struct {
	// titleTokens are the significant words before the first marker (season,
	// episode, year, quality tag, bracket...). Leading [Group] tags are
	// skipped.
	titleTokens []string
	// countries are scene country tags in the title ("The Office US").
	countries map[string]bool
	// titleYear is a year written right after the title, the series or
	// film year by scene convention ("The Office 2005 S02E01").
	titleYear int
	// altTokens are words of a bracketed alternate title inside the title
	// portion ("Kimetsu no Yaiba (Demon Slayer) ...").
	altTokens []string
	year      int

	seasons        map[int]bool // explicitly named seasons, ranges expanded
	completeSeries bool         // "Complete Series", "All Seasons"
	pack           bool         // complete / batch / collection keyword

	// seasonEpisodes are SxxEyy (or 1x01) pairs; episodeRanges carry
	// "S01E01-E03" and "01-12" spans; absolutes are anime-style bare numbers.
	seasonEpisodes []seasonEpisodePair
	episodeRanges  []episodeSpan
	absolutes      []int

	resolution int    // 2160, 1080, 720, 576, 480; 0 when unknown
	source     string // remux, bluray, web-dl, webrip, web, hdtv, dvd, hdrip
	junk       bool   // cam, telesync, telecine, screener, pre-DVD, 3D

	audio        map[languageCode]bool
	multiAudio   bool // dual / multi audio
	dubbed       bool
	chineseSubs  bool // CHS/CHT/GB/BIG5 subtitle releases
	foreignSubs  bool // VOSTFR / SUBFRENCH / Legendado: non-English subtitles
	raw          bool // untranslated anime raw
	movie        bool // "Movie", "Gekijouban": a film, not an episode
	subGroupHint bool // a known English fansub group or explicit English subs
}

type seasonEpisodePair struct{ season, episode int }

type episodeSpan struct{ season, from, to int } // season 0 = unspecified

var (
	leadingGroupPattern = regexp.MustCompile(`^\s*(?:\[[^\]]*\]|\([^)]*\)|【[^】]*】)\s*[-_.]?\s*`)
	releaseWordPattern  = regexp.MustCompile(`[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*`)

	seasonTokenPattern   = regexp.MustCompile(`^s\d{1,3}(?:e\d{1,4})*$`)
	crossTokenPattern    = regexp.MustCompile(`^\d{1,2}x\d{2,3}$`)
	episodeTokenPattern  = regexp.MustCompile(`^(?:e|ep)\d{1,4}$`)
	yearTokenPattern     = regexp.MustCompile(`^(?:19|20)\d{2}$`)
	numberTokenPattern   = regexp.MustCompile(`^\d{1,4}$`)
	resolutionToken      = regexp.MustCompile(`^(?:\d{3,4}[pi]|4k|uhd)$`)
	ordinalTokenPattern  = regexp.MustCompile(`^\d{1,2}(?:st|nd|rd|th)$`)
	versionedNumberToken = regexp.MustCompile(`^\d{1,4}v\d$`)
	digitsPattern        = regexp.MustCompile(`\d{1,2}`)

	// Season ranges are "S01-S05" (spaces allowed) or a tight "S01-5"; anime
	// "S2 - 05" is season 2 episode 5, never seasons 2 to 5.
	seasonRangePattern   = regexp.MustCompile(`(?i)\bs(\d{1,2})(?:\s*(?:-|~|to)\s*s(\d{1,2})|-(\d{1,2}))\b`)
	seasonListPattern    = regexp.MustCompile(`(?i)\bs(\d{1,2})((?:\s*(?:,|&|and)\s*s?\d{1,2}\b|\s*-\s*s\d{1,2}\b)+)`)
	seasonPairPattern    = regexp.MustCompile(`(?i)\bs(\d{1,3})\s*e(\d{1,4})(?:\s*-?\s*e?(\d{1,4}))?\b`)
	seasonOnlyPattern    = regexp.MustCompile(`(?i)\bs(\d{1,3})\b`)
	seasonWordPattern    = regexp.MustCompile(`(?i)\bseasons?\s*(\d{1,2})(?:\s*(?:-|~|to|&|and)\s*(\d{1,2}))?\b`)
	seasonOrdinalPattern = regexp.MustCompile(`(?i)\b(\d{1,2})(?:st|nd|rd|th)\s*season\b`)
	crossPattern         = regexp.MustCompile(`(?i)\b(\d{1,2})x(\d{2,3})\b`)
	episodeWordPattern   = regexp.MustCompile(`(?i)\b(?:e|ep|episodes?)\s*(\d{1,4})(?:\s*(?:-|~|to)\s*(?:e|ep)?\s*(\d{1,4}))?\b`)
	absoluteRangePattern = regexp.MustCompile(`(?:^|[\s\[(])(\d{1,4})\s*(?:-|~|to)\s*(\d{1,4})(?:v\d)?(?:$|[\s\])])`)
	completeSeriesPatt   = regexp.MustCompile(`(?i)\b(?:complete[\s-]*series|all[\s-]*seasons|complete[\s-]*collection|full[\s-]*series)\b`)
	packWordPattern      = regexp.MustCompile(`(?i)\b(?:complete|batch|collection|season[\s-]*pack|full[\s-]*season|box[\s-]*set)\b`)

	resolutionPattern = regexp.MustCompile(`(?i)\b(2160|1080|720|576|480)[pi]\b`)
	uhdPattern        = regexp.MustCompile(`(?i)\b(?:4k|uhd)\b`)
	junkPattern       = regexp.MustCompile(`(?i)\b(?:(?:hd)?cam(?:rip)?|(?:hd)?ts|telesync|(?:hd)?tc|telecine|scr|dvdscr|screener|p(?:re)?[\s-]?dvd(?:rip)?|hq[\s-]?cam)\b`)
	sourcePatterns    = []struct {
		name    string
		pattern *regexp.Regexp
	}{
		{"remux", regexp.MustCompile(`(?i)\b(?:remux|bdremux)\b`)},
		{"bluray", regexp.MustCompile(`(?i)\b(?:blu[\s-]?ray|bdrip|brrip|bd)\b`)},
		{"web-dl", regexp.MustCompile(`(?i)\bweb[\s-]?dl\b`)},
		{"webrip", regexp.MustCompile(`(?i)\bweb[\s-]?rip\b`)},
		{"web", regexp.MustCompile(`(?i)\bweb\b`)},
		{"hdtv", regexp.MustCompile(`(?i)\bhdtv\b`)},
		{"dvd", regexp.MustCompile(`(?i)\b(?:dvd[\s-]?rip|dvd(?:[\s-]?(?:5|9|r))?)\b`)},
		{"hdrip", regexp.MustCompile(`(?i)\bhd[\s-]?rip\b`)},
	}

	multiAudioRelease = regexp.MustCompile(`(?i)\b(?:dual[\s-]*audio|dual|multi[\s-]*audio|multi(?:[\s-]*lang(?:uage)?s?)?)\b`)
	multiSubsRelease  = regexp.MustCompile(`(?i)\bmulti[\s-]*subs?\b`)
	dubbedRelease     = regexp.MustCompile(`(?i)\b(?:dub|dubbed|dubs)\b`)
	chineseSubRelease = regexp.MustCompile(`(?i)\b(?:chs|cht|gb|big5|chs[\s_&-]*cht|gb[\s_&-]*big5)\b|简|繁`)
	rawRelease        = regexp.MustCompile(`(?i)\braws?\b`)
	groupRawRelease   = regexp.MustCompile(`(?i)raws?\b`) // "[AsukaRaws]", "[Ohys-Raws]"
	foreignSubRelease = regexp.MustCompile(`(?i)\b(?:vostfr|vost|subfrench|sub[\s-]?fr|legendado|legendas|subtitulado|sub[\s-]?ita|subesp|sub[\s-]?esp)\b`)
	threeDRelease     = regexp.MustCompile(`(?i)\b(?:3d|h?sbs|h?ou)\b`)
	englishSubRelease = regexp.MustCompile(`(?i)\b(?:e[\s-]?subs?|eng(?:lish)?[\s-]*subs?|subbed|softsubs?)\b`)
	fansubGroups      = regexp.MustCompile(`(?i)\b(?:subsplease|erai[\s-]?raws|horriblesubs|commie|doki|ember|judas|asw|yameii|varyg|anime[\s-]?time|dkb|toonshub|kawaiika|smol|cleo|tenrai)\b`)
)

// markerWords end a release's title portion unless the request's own title
// contains the word (so "Seasons" in "The Four Seasons" stays a title word).
var markerWords = map[string]bool{
	"season": true, "seasons": true, "complete": true, "batch": true, "collection": true,
	"episode": true, "episodes": true, "ep": true, "vol": true, "volume": true,
	"bluray": true, "blu": true, "bdrip": true, "brrip": true, "bdremux": true, "remux": true,
	"webrip": true, "webdl": true, "web": true, "hdtv": true, "dvdrip": true, "dvd": true,
	"hdrip": true, "hdcam": true, "cam": true, "camrip": true, "hdts": true, "ts": true,
	"telesync": true, "tc": true, "hdtc": true, "telecine": true, "scr": true, "dvdscr": true,
	"screener": true, "pdvd": true, "predvd": true, "x264": true, "x265": true, "h264": true,
	"h265": true, "hevc": true, "avc": true, "av1": true, "xvid": true, "divx": true,
	"aac": true, "ac3": true, "dts": true, "ddp": true, "ddp5": true, "atmos": true,
	"10bit": true, "8bit": true, "hdr": true, "hdr10": true, "proper": true, "repack": true,
	"internal": true, "limited": true, "extended": true, "imax": true, "remastered": true,
	"uncut": true, "unrated": true, "theatrical": true, "dubbed": true, "dub": true,
	"dual": true, "multi": true, "subbed": true, "esub": true, "esubs": true, "nf": true,
	"amzn": true, "atvp": true, "dsnp": true, "hmax": true, "hulu": true, "hindi": true,
	"english": true, "tamil": true, "telugu": true, "malayalam": true, "kannada": true,
	"japanese": true, "korean": true, "french": true, "italian": true, "spanish": true,
	"german": true, "russian": true, "movie": true, "ova": true, "ona": true, "oad": true,
	"special": true, "specials": true, "mkv": true, "mp4": true, "avi": true,
}

// ignorableTitleTokens are scene country tags ("The Office US") that never
// make a release a different title.
var ignorableTitleTokens = map[string]bool{"us": true, "uk": true, "au": true, "nz": true, "ca": true}

// parseRelease reads one release name. protected holds the request's own
// title words: they never end the title portion ("2049", "100", "Seasons").
func parseRelease(name string, protected map[string]bool) parsedRelease {
	parsed := parsedRelease{seasons: map[int]bool{}, audio: map[languageCode]bool{}, countries: map[string]bool{}}

	cleaned := name
	for {
		match := leadingGroupPattern.FindString(cleaned)
		if match == "" {
			break
		}
		if fansubGroups.MatchString(match) || englishSubRelease.MatchString(match) {
			parsed.subGroupHint = true
		}
		if chineseSubRelease.MatchString(match) {
			parsed.chineseSubs = true
		}
		if groupRawRelease.MatchString(strings.ReplaceAll(strings.ToLower(match), "erai-raws", "")) {
			parsed.raw = true
		}
		cleaned = cleaned[len(match):]
	}
	cleaned = strings.NewReplacer(".", " ", "_", " ").Replace(cleaned)
	lower := strings.ToLower(accentFold.Replace(cleaned))

	boundary := scanTitle(&parsed, lower, protected)
	rest := lower[boundary:]
	for _, word := range strings.Fields(normalizeAnimeTitle(lower[:boundary])) {
		if ignorableTitleTokens[word] {
			parsed.countries[word] = true
		}
	}
	if first := releaseWordPattern.FindString(rest); yearTokenPattern.MatchString(first) && !protected[first] {
		parsed.titleYear, _ = strconv.Atoi(first)
	}

	parsed.year = lastYear(rest, protected)
	parseSeasonsAndEpisodes(&parsed, rest)
	parseQuality(&parsed, rest)
	parseLanguages(&parsed, rest)
	parsed.movie = movieReleasePattern.MatchString(rest)
	if fansubGroups.MatchString(lower) || englishSubRelease.MatchString(rest) {
		parsed.subGroupHint = true
	}
	return parsed
}

// scanTitle collects the title words up to the first marker word and returns
// where the title portion ends. A bracket group made only of plain words is
// an alternate title and the scan continues after it; a group holding a
// marker ("(2014)", "[1080p]") ends the title.
func scanTitle(parsed *parsedRelease, lower string, protected map[string]bool) int {
	addWords := func(target *[]string, text string) {
		*target = append(*target, significantTokens(text)...)
	}
	position := 0
	for position < len(lower) {
		open := strings.IndexAny(lower[position:], "[(【{")
		segmentEnd := len(lower)
		if open >= 0 {
			segmentEnd = position + open
		}
		segment := lower[position:segmentEnd]
		if cut, found := firstMarker(segment, protected); found {
			addWords(&parsed.titleTokens, segment[:cut])
			return position + cut
		}
		addWords(&parsed.titleTokens, segment)
		if open < 0 {
			return len(lower)
		}
		closeIndex := strings.IndexAny(lower[segmentEnd+1:], "])】}")
		if closeIndex < 0 {
			return segmentEnd
		}
		group := lower[segmentEnd+1 : segmentEnd+1+closeIndex]
		if len(parsed.titleTokens) == 0 {
			return segmentEnd
		}
		if _, hasMarker := firstMarker(group, protected); hasMarker {
			return segmentEnd
		}
		addWords(&parsed.altTokens, group)
		position = segmentEnd + 1 + closeIndex + 1
	}
	return len(lower)
}

// firstMarker finds the first marker word in text.
func firstMarker(text string, protected map[string]bool) (int, bool) {
	for _, word := range releaseWordPattern.FindAllStringIndex(text, -1) {
		if isMarkerToken(text[word[0]:word[1]], protected) {
			return word[0], true
		}
	}
	return 0, false
}

func isMarkerToken(token string, protected map[string]bool) bool {
	if protected[token] {
		return false
	}
	switch {
	case seasonTokenPattern.MatchString(token), crossTokenPattern.MatchString(token),
		episodeTokenPattern.MatchString(token), resolutionToken.MatchString(token),
		ordinalTokenPattern.MatchString(token), versionedNumberToken.MatchString(token):
		return true
	case yearTokenPattern.MatchString(token), numberTokenPattern.MatchString(token):
		return true
	}
	return markerWords[token]
}

func lastYear(rest string, protected map[string]bool) int {
	year := 0
	for _, match := range releaseYearPattern.FindAllStringSubmatch(rest, -1) {
		if protected[match[1]] {
			continue
		}
		if value, err := strconv.Atoi(match[1]); err == nil {
			year = value
		}
	}
	return year
}

func parseSeasonsAndEpisodes(parsed *parsedRelease, rest string) {
	addSeason := func(value int) {
		if value > 0 && value < 100 {
			parsed.seasons[value] = true
		}
	}
	addSeasonRange := func(from, to int) {
		if from > 0 && to >= from && to-from < 50 {
			for season := from; season <= to; season++ {
				addSeason(season)
			}
		}
	}

	for _, match := range seasonPairPattern.FindAllStringSubmatch(rest, -1) {
		season, _ := strconv.Atoi(match[1])
		episode, _ := strconv.Atoi(match[2])
		addSeason(season)
		parsed.seasonEpisodes = append(parsed.seasonEpisodes, seasonEpisodePair{season, episode})
		if match[3] != "" {
			if end, err := strconv.Atoi(match[3]); err == nil && end > episode {
				parsed.episodeRanges = append(parsed.episodeRanges, episodeSpan{season, episode, end})
			}
		}
	}
	for _, match := range crossPattern.FindAllStringSubmatch(rest, -1) {
		season, _ := strconv.Atoi(match[1])
		episode, _ := strconv.Atoi(match[2])
		addSeason(season)
		parsed.seasonEpisodes = append(parsed.seasonEpisodes, seasonEpisodePair{season, episode})
	}
	for _, match := range seasonRangePattern.FindAllStringSubmatch(rest, -1) {
		from, _ := strconv.Atoi(match[1])
		end := match[2]
		if end == "" {
			end = match[3]
		}
		to, _ := strconv.Atoi(end)
		addSeasonRange(from, to)
	}
	for _, match := range seasonListPattern.FindAllStringSubmatch(rest, -1) {
		first, _ := strconv.Atoi(match[1])
		addSeason(first)
		for _, number := range digitsPattern.FindAllString(match[2], -1) {
			value, _ := strconv.Atoi(number)
			addSeason(value)
		}
	}
	for _, match := range seasonOnlyPattern.FindAllStringSubmatch(rest, -1) {
		value, _ := strconv.Atoi(match[1])
		addSeason(value)
	}
	for _, match := range seasonWordPattern.FindAllStringSubmatch(rest, -1) {
		from, _ := strconv.Atoi(match[1])
		if match[2] != "" {
			to, _ := strconv.Atoi(match[2])
			addSeasonRange(from, to)
		} else {
			addSeason(from)
		}
	}
	for _, match := range seasonOrdinalPattern.FindAllStringSubmatch(rest, -1) {
		value, _ := strconv.Atoi(match[1])
		addSeason(value)
	}
	parsed.completeSeries = completeSeriesPatt.MatchString(rest)
	parsed.pack = parsed.completeSeries || packWordPattern.MatchString(rest)

	// Tagged episodes outside SxxEyy ("E05", "Ep 05", "Episodes 1-12").
	withoutPairs := seasonPairPattern.ReplaceAllString(rest, " ")
	for _, match := range episodeWordPattern.FindAllStringSubmatch(withoutPairs, -1) {
		from, _ := strconv.Atoi(match[1])
		if match[2] != "" {
			if to, err := strconv.Atoi(match[2]); err == nil && to > from {
				parsed.episodeRanges = append(parsed.episodeRanges, episodeSpan{0, from, to})
				continue
			}
		}
		parsed.absolutes = append(parsed.absolutes, from)
	}

	// Anime-style bare numbers ("Show - 05", "Show 01", "(01-11)") count only
	// before the first quality/codec tag, where "1080" or "5.1" cannot be
	// mistaken for an episode.
	head := rest
	if cut := firstQualityIndex(head); cut >= 0 {
		head = head[:cut]
	}
	head = seasonPairPattern.ReplaceAllString(head, " ")
	head = seasonWordPattern.ReplaceAllString(head, " ")
	head = seasonOrdinalPattern.ReplaceAllString(head, " ")
	head = seasonRangePattern.ReplaceAllString(head, " ")
	head = seasonOnlyPattern.ReplaceAllString(head, " ")
	head = episodeWordPattern.ReplaceAllString(head, " ")
	head = releaseYearPattern.ReplaceAllString(head, " ")
	for _, match := range absoluteRangePattern.FindAllStringSubmatch(head, -1) {
		from, _ := strconv.Atoi(match[1])
		to, _ := strconv.Atoi(match[2])
		if to > from {
			parsed.episodeRanges = append(parsed.episodeRanges, episodeSpan{0, from, to})
		}
	}
	head = absoluteRangePattern.ReplaceAllString(head, " ")
	for _, word := range releaseWordPattern.FindAllString(head, -1) {
		word = strings.SplitN(word, "v", 2)[0] // "05v2"
		if numberTokenPattern.MatchString(word) {
			value, _ := strconv.Atoi(word)
			parsed.absolutes = append(parsed.absolutes, value)
		}
	}
}

var qualityStartPattern = regexp.MustCompile(`(?i)\b(?:\d{3,4}[pi]|4k|uhd|blu[\s-]?ray|bdrip|brrip|web[\s-]?(?:dl|rip)?|hdtv|dvd\w*|hdrip|x26[45]|h26[45]|hevc|avc|xvid|divx|aac|ac3|dts|ddp?\d?|atmos|10bit|8bit|mkv|mp4|avi|cr|nf|amzn)\b`)

func firstQualityIndex(value string) int {
	if location := qualityStartPattern.FindStringIndex(value); location != nil {
		return location[0]
	}
	return -1
}

func parseQuality(parsed *parsedRelease, rest string) {
	if match := resolutionPattern.FindStringSubmatch(rest); match != nil {
		parsed.resolution, _ = strconv.Atoi(match[1])
	} else if uhdPattern.MatchString(rest) {
		parsed.resolution = 2160
	}
	for _, candidate := range sourcePatterns {
		if candidate.pattern.MatchString(rest) {
			parsed.source = candidate.name
			break
		}
	}
	parsed.junk = junkPattern.MatchString(rest) || threeDRelease.MatchString(rest)
}

// releaseLanguageCodes maps the full names and scene abbreviations releases
// use for audio tracks.
var releaseLanguageCodes = map[string]languageCode{
	"english": "en", "eng": "en",
	"hindi": "hi", "hin": "hi",
	"tamil": "ta", "tam": "ta", "telugu": "te", "tel": "te",
	"malayalam": "ml", "mal": "ml", "kannada": "kn", "kan": "kn",
	"bengali": "bn", "bangla": "bn", "marathi": "mr", "punjabi": "pa", "urdu": "ur",
	"japanese": "ja", "jpn": "ja", "jap": "ja", "korean": "ko", "kor": "ko",
	"chinese": "zh", "mandarin": "zh", "cantonese": "zh", "chi": "zh",
	"french": "fr", "fre": "fr", "fra": "fr", "vff": "fr", "truefrench": "fr",
	"german": "de", "ger": "de", "deu": "de", "spanish": "es", "spa": "es", "esp": "es",
	"latino": "es", "castellano": "es", "portuguese": "pt", "por": "pt", "brazilian": "pt",
	"russian": "ru", "rus": "ru", "italian": "it", "ita": "it", "turkish": "tr", "tur": "tr",
	"arabic": "ar", "ara": "ar", "polish": "pl", "pol": "pl", "thai": "th", "tha": "th",
	"indonesian": "id", "vietnamese": "vi", "vie": "vi", "ukrainian": "uk", "ukr": "uk",
	"persian": "fa", "farsi": "fa", "dutch": "nl", "dut": "nl", "nld": "nl",
	"hungarian": "hu", "hun": "hu", "czech": "cs", "cze": "cs", "swedish": "sv", "swe": "sv",
	"vf": "fr", "vfq": "fr", "vfi": "fr", "galician": "gl", "galego": "gl", "catalan": "ca",
	"catala": "ca", "basque": "eu", "greek": "el", "hebrew": "he", "romanian": "ro",
	"bulgarian": "bg", "croatian": "hr", "serbian": "sr", "finnish": "fi", "norwegian": "no",
	"danish": "da", "slovak": "sk", "lithuanian": "lt", "latvian": "lv", "estonian": "et",
}

var subtitleWords = map[string]bool{
	"sub": true, "subs": true, "subbed": true, "subtitle": true, "subtitles": true,
	"subtitulado": true, "subtitulada": true, "legendado": true, "vostfr": true, "srt": true,
}

func parseLanguages(parsed *parsedRelease, rest string) {
	words := releaseWordPattern.FindAllString(rest, -1)
	for i, word := range words {
		code, ok := releaseLanguageCodes[word]
		if !ok {
			continue
		}
		subtitleContext := (i > 0 && subtitleWords[words[i-1]]) || (i+1 < len(words) && subtitleWords[words[i+1]])
		// "Sub Ita Eng": every language in a run after "sub" is a subtitle.
		for j := i - 1; j >= 0 && !subtitleContext; j-- {
			if subtitleWords[words[j]] {
				subtitleContext = true
				break
			}
			if _, isLanguage := releaseLanguageCodes[words[j]]; !isLanguage {
				break
			}
		}
		if !subtitleContext {
			parsed.audio[code] = true
		}
	}
	withoutSubs := multiSubsRelease.ReplaceAllString(rest, " ")
	parsed.multiAudio = multiAudioRelease.MatchString(withoutSubs)
	parsed.dubbed = dubbedRelease.MatchString(rest)
	if chineseSubRelease.MatchString(rest) {
		parsed.chineseSubs = true
	}
	parsed.foreignSubs = foreignSubRelease.MatchString(rest)
	if rawRelease.MatchString(strings.ReplaceAll(rest, "erai-raws", "")) {
		parsed.raw = true
	}
	for _, match := range shortLanguageList.FindAllString(rest, -1) {
		for _, code := range shortLanguageSplit.Split(match, -1) {
			if value, ok := shortLanguageCodes[code]; ok {
				parsed.audio[value] = true
			}
		}
	}
}

// shortLanguageList reads two-letter audio lists such as "EN/ITA/FR/ES";
// single two-letter words are too ambiguous to count.
var (
	shortLanguageList  = regexp.MustCompile(`(?i)\b(?:en|fr|es|de|it|hi|ja|ko|ru|pt|pl|ta|te|ita|eng|fre|spa|ger|rus|jpn|hin)(?:\s*[/+]\s*(?:en|fr|es|de|it|hi|ja|ko|ru|pt|pl|ta|te|ita|eng|fre|spa|ger|rus|jpn|hin))+\b`)
	shortLanguageSplit = regexp.MustCompile(`\s*[/+]\s*`)
	shortLanguageCodes = map[string]languageCode{
		"en": "en", "fr": "fr", "es": "es", "de": "de", "it": "it", "hi": "hi", "ja": "ja",
		"ko": "ko", "ru": "ru", "pt": "pt", "pl": "pl", "ta": "ta", "te": "te", "ita": "it",
		"eng": "en", "fre": "fr", "spa": "es", "ger": "de", "rus": "ru", "jpn": "ja", "hin": "hi",
	}
	movieReleasePattern = regexp.MustCompile(`(?i)\b(?:movie|gekijou?[\s-]?ban|the[\s-]movie|film)\b`)
)
