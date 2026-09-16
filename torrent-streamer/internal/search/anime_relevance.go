package search

import (
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

var (
	animeSeasonPattern        = regexp.MustCompile(`(?i)\bs(?:eason)?[ ._-]*(\d{1,2})(?:[ ._-]*e\d{1,3})?(?:\b|_)`)
	animeOrdinalSeasonPattern = regexp.MustCompile(`(?i)\b(\d{1,2})(?:st|nd|rd|th)[ ._-]*season\b`)
	// cjkTitlePattern matches Japanese-script release titles (kanji, hiragana,
	// katakana). The app's anime preference is ROMAJI/English-subbed releases;
	// Japanese-script titles are raws or local-language releases and are never
	// relevant, whatever alias matched them.
	cjkTitlePattern = regexp.MustCompile(`[\p{Han}\p{Hiragana}\p{Katakana}]`)
)

func animeReleaseRelevant(request Request, releaseTitle string) bool {
	if cjkTitlePattern.MatchString(releaseTitle) {
		return false // romaji preference: Japanese-script titles are excluded
	}
	if !animeTitleMatches(request, releaseTitle) {
		return false
	}

	wantSeason, hasWantedSeason := requestedAnimeSeason(request)
	if !hasWantedSeason {
		// Anime requests without an explicit season (title-level search)
		// mean the FIRST season: absolute episode numbering starts at 1 and
		// later seasons always mark themselves ("S2", "2nd Season") in their
		// titles. Defaulting keeps sequels out of a season-1 title's results.
		wantSeason, hasWantedSeason = 1, true
	}
	gotSeason, hasReleaseSeason := explicitAnimeSeason(releaseTitle)
	if !hasWantedSeason || !hasReleaseSeason {
		return true
	}

	return gotSeason == wantSeason
}

func animeTitleMatches(request Request, releaseTitle string) bool {
	releaseTitle = normalizeAnimeTitle(stripAnimeSeason(releaseTitle))
	if releaseTitle == "" {
		return false
	}
	releaseTitle = " " + releaseTitle + " "

	// Significant-token matching: EVERY meaningful word of the requested
	// title (or of any alias) must appear as a word in the release title.
	// Stopwords are ignored ("Movie, The" matches "The Movie", "&" matches
	// "and"), accents are folded, and word boundaries hold ("Example" never
	// matches "Exampled"). A completely different title has no overlap and
	// is rejected.
	titles := make([]string, 0, len(request.Aliases)+1)
	titles = append(titles, request.Title)
	titles = append(titles, request.Aliases...)
	for _, title := range titles {
		tokens := significantTokens(title)
		if len(tokens) == 0 {
			continue
		}
		all := true
		for _, token := range tokens {
			if !strings.Contains(releaseTitle, " "+token+" ") {
				all = false
				break
			}
		}
		if all {
			return true
		}
	}

	return false
}

func significantTokens(title string) []string {
	tokens := []string{}
	for _, word := range strings.Fields(normalizeAnimeTitle(stripAnimeSeason(title))) {
		if len(word) >= 2 && !titleStopwords[word] {
			tokens = append(tokens, word)
		}
	}
	return tokens
}

func requestedAnimeSeason(request Request) (int, bool) {
	if request.Season != nil && *request.Season > 0 {
		return *request.Season, true
	}

	titles := make([]string, 0, len(request.Aliases)+1)
	titles = append(titles, request.Title)
	titles = append(titles, request.Aliases...)
	for _, title := range titles {
		if season, ok := explicitAnimeSeason(title); ok {
			return season, true
		}
	}

	return 0, false
}

func explicitAnimeSeason(value string) (int, bool) {
	for _, pattern := range []*regexp.Regexp{animeSeasonPattern, animeOrdinalSeasonPattern} {
		match := pattern.FindStringSubmatch(value)
		if len(match) != 2 {
			continue
		}

		season, err := strconv.Atoi(match[1])
		if err == nil && season > 0 {
			return season, true
		}
	}

	return 0, false
}

func stripAnimeSeason(value string) string {
	value = animeSeasonPattern.ReplaceAllString(value, " ")
	return animeOrdinalSeasonPattern.ReplaceAllString(value, " ")
}

// accentFold maps common accented Latin letters to their base form so scene
// releases ("Amelie") match canonical titles ("Amélie").
var accentFold = strings.NewReplacer(
	"à", "a", "á", "a", "â", "a", "ã", "a", "ä", "a", "å", "a",
	"è", "e", "é", "e", "ê", "e", "ë", "e",
	"ì", "i", "í", "i", "î", "i", "ï", "i",
	"ò", "o", "ó", "o", "ô", "o", "õ", "o", "ö", "o",
	"ù", "u", "ú", "u", "û", "u", "ü", "u",
	"ñ", "n", "ç", "c", "ý", "y", "ÿ", "y",
	"æ", "ae", "œ", "oe", "ß", "ss",
)

// titleStopwords: connective words scene releases freely drop or reorder
// ("Movie, The" vs "The Movie", "&" vs "and", dropped "of the"). Titles are
// compared over their SIGNIFICANT token sets, so these never break a match.
var titleStopwords = map[string]bool{
	"the": true, "a": true, "an": true, "and": true, "of": true,
	"in": true, "on": true, "to": true, "for": true, "no": true,
}

func normalizeAnimeTitle(value string) string {
	value = accentFold.Replace(value)
	var normalized strings.Builder
	normalized.Grow(len(value))
	needsSpace := false
	for _, char := range value {
		switch {
		case unicode.IsLetter(char), unicode.IsNumber(char):
			if needsSpace && normalized.Len() > 0 {
				normalized.WriteByte(' ')
			}
			normalized.WriteRune(unicode.ToLower(char))
			needsSpace = false
		case char == '\'', char == '’', char == 'ʼ':
			// Apostrophes do not split a word: "Journey's" and "Journeys" match.
		default:
			needsSpace = true
		}
	}

	return normalized.String()
}
