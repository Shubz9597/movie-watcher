package search

import (
	"regexp"
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

// significantTokens are the words two titles are compared on: normalized,
// without connectives or scene country tags. Single characters stay ("3
// Idiots", "Dragon Ball Z").
func significantTokens(title string) []string {
	tokens := []string{}
	for _, word := range strings.Fields(normalizeAnimeTitle(title)) {
		if !titleStopwords[word] && !ignorableTitleTokens[word] {
			tokens = append(tokens, word)
		}
	}
	return tokens
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
