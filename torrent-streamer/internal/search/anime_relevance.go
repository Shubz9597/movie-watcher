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
)

func animeReleaseRelevant(request Request, releaseTitle string) bool {
	if !animeTitleMatches(request, releaseTitle) {
		return false
	}

	wantSeason, hasWantedSeason := requestedAnimeSeason(request)
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

	titles := make([]string, 0, len(request.Aliases)+1)
	titles = append(titles, request.Title)
	titles = append(titles, request.Aliases...)
	for _, title := range titles {
		title = normalizeAnimeTitle(stripAnimeSeason(title))
		if title != "" && strings.Contains(releaseTitle, " "+title+" ") {
			return true
		}
	}

	return false
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

func normalizeAnimeTitle(value string) string {
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
