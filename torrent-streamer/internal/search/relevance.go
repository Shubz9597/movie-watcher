package search

import (
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

// classifyRelease maps one Prowlarr release to its relevance verdict.
func classifyRelease(request Request, release prowlarrRelease) releaseClass {
	// 1. Title gate (every kind). An imdbId match from the indexer itself is
	// authoritative and bypasses textual title matching (release titles are
	// noisy; indexer ids are not).
	if normalizeIMDBID(release.ImdbID) != "" && request.IMDBID != "" &&
		normalizeIMDBID(release.ImdbID) == normalizeIMDBID(request.IMDBID) {
		return classifyEvidence(request, release.Title)
	}
	if request.Kind == KindAnime {
		if !animeReleaseRelevant(request, release.Title) {
			return classReject
		}
	} else if !animeTitleMatches(Request{Title: request.Title, Aliases: request.Aliases}, release.Title) {
		return classReject
	}
	return classifyEvidence(request, release.Title)
}

// classifyEvidence checks the request-kind-specific explicit evidence.
func classifyEvidence(request Request, releaseTitle string) releaseClass {
	switch request.Kind {
	case KindMovie:
		return classifyMovieEvidence(request, releaseTitle)
	default: // KindTV, KindAnime: season/episode evidence.
		return classifyEpisodeEvidence(request, releaseTitle)
	}
}

// classifyMovieEvidence: an explicit release year is checked against the
// requested year — remakes and wrong-year editions are rejected; a matching
// year verifies; no year leaves the release ambiguous.
func classifyMovieEvidence(request Request, releaseTitle string) releaseClass {
	year, ok := releaseExplicitYear(request, releaseTitle)
	if !ok || request.Year <= 0 {
		return classAmbiguous
	}
	if year == request.Year {
		return classVerified
	}
	return classReject
}

// releaseExplicitYear returns the release-year token: the LAST year-like
// token that is not itself a word of the requested title or aliases (so
// "Blade Runner 2049" is never read as a 2049 release).
func releaseExplicitYear(request Request, releaseTitle string) (int, bool) {
	titleWords := map[string]bool{}
	for _, known := range append([]string{request.Title}, request.Aliases...) {
		for _, word := range strings.Fields(normalizeAnimeTitle(known)) {
			titleWords[word] = true
		}
	}
	year := 0
	for _, match := range releaseYearPattern.FindAllStringSubmatch(releaseTitle, -1) {
		value, err := strconv.Atoi(match[1])
		if err != nil {
			continue
		}
		if titleWords[strconv.Itoa(value)] {
			continue // part of the requested title ("2049"), not the release year
		}
		year = value
	}
	if year == 0 {
		return 0, false
	}
	return year, true
}

// classifyEpisodeEvidence verifies season/episode/pack coverage for TV and
// anime. Explicit contradictions reject; explicit matches verify; releases
// with no parseable evidence stay ambiguous.
func classifyEpisodeEvidence(request Request, releaseTitle string) releaseClass {
	episode, absolute := request.Episode, request.Absolute
	target := episode
	if absolute != nil {
		target = absolute
	}
	targets := map[int]bool{}
	if target != nil {
		targets[*target] = true
	}
	if episode != nil && absolute != nil {
		targets[*episode] = true
	}

	// Season evidence first: an explicit season that contradicts the request
	// rejects regardless of episode numbering.
	if season, ok := explicitAnimeSeason(releaseTitle); ok && request.Season != nil && season != *request.Season {
		return classReject
	}

	if target != nil {
		// Episode-range packs FIRST: "S01 E01-E12" parses as a season-episode
		// token S01E01 under the SxxEyy pattern, so range coverage must be
		// verified before any per-episode rejection.
		sawRange := false
		for _, match := range episodeRange.FindAllStringSubmatch(releaseTitle, -1) {
			start, errStart := strconv.Atoi(match[1])
			end, errEnd := strconv.Atoi(match[2])
			if errStart != nil || errEnd != nil || end < start {
				continue
			}
			sawRange = true
			if start <= *target && *target <= end {
				return classVerified // pack coverage provably includes the episode
			}
		}
		if sawRange {
			return classReject // range evidence present, request not covered
		}

		// Explicit SxxEyy tokens are authoritative: a matching one verifies;
		// a contradicting one rejects.
		sawSeasonEpisode := false
		for _, match := range seasonEpisode.FindAllStringSubmatch(releaseTitle, -1) {
			foundSeason, _ := strconv.Atoi(match[1])
			foundEpisode, _ := strconv.Atoi(match[2])
			sawSeasonEpisode = true
			if request.Season != nil && foundSeason != *request.Season {
				return classReject
			}
			if targets[foundEpisode] {
				return classVerified
			}
		}
		if sawSeasonEpisode {
			return classReject // season-episode evidence present, none matched
		}

		// Tagged episode tokens (E05 / EP 5 / Episode 5 / #5).
		for _, match := range episodeToken.FindAllStringSubmatch(releaseTitle, -1) {
			found, err := strconv.Atoi(match[1])
			if err != nil {
				continue
			}
			if targets[found] {
				return classVerified
			}
			return classReject // explicit tagged episode contradicts the request
		}

		// Loose absolute number (anime convention "Show - 05"): match-only,
		// bare numbers are never reject evidence ("1080" is a resolution).
		if absolute != nil {
			looseToken := regexp.MustCompile(`(?i)\b0*` + strconv.Itoa(*absolute) + `\b`)
			if looseToken.MatchString(releaseTitle) {
				return classVerified
			}
		}
	}

	// Pack keywords: verify the pack's actual season coverage. "Complete
	// season" of the requested season covers any episode; of another season
	// it is a mismatch; without a season marker the coverage is unverifiable.
	if packToken.MatchString(releaseTitle) {
		season, hasSeason := explicitAnimeSeason(releaseTitle)
		if hasSeason {
			if request.Season != nil && season != *request.Season {
				return classReject
			}
			if request.Season != nil {
				return classVerified
			}
		}
		return classAmbiguous // coverage unverifiable
	}

	// Season-only evidence with no episode requested verifies the season.
	if target == nil {
		if season, ok := explicitAnimeSeason(releaseTitle); ok && request.Season != nil && season == *request.Season {
			return classVerified
		}
	}
	return classAmbiguous
}
