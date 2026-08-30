package search

import (
	"regexp"
	"strings"
)

type languageCode string

const languageEnglish languageCode = "en"

type languagePattern struct {
	code    languageCode
	query   string
	pattern *regexp.Regexp
}

var (
	languagePatterns = []languagePattern{
		{code: "en", query: "English", pattern: regexp.MustCompile(`(?i)\b(?:english|eng|en[ ._-]?(?:us|gb|uk))\b`)},
		{code: "hi", query: "Hindi", pattern: regexp.MustCompile(`(?i)\b(?:hindi|hin(?:di)?|hind)\b`)},
		{code: "ta", query: "Tamil", pattern: regexp.MustCompile(`(?i)\btamil\b`)},
		{code: "te", query: "Telugu", pattern: regexp.MustCompile(`(?i)\btelugu\b`)},
		{code: "ml", query: "Malayalam", pattern: regexp.MustCompile(`(?i)\bmalayalam\b`)},
		{code: "kn", query: "Kannada", pattern: regexp.MustCompile(`(?i)\bkannada\b`)},
		{code: "bn", query: "Bengali", pattern: regexp.MustCompile(`(?i)\b(?:bengali|bangla)\b`)},
		{code: "mr", query: "Marathi", pattern: regexp.MustCompile(`(?i)\bmarathi\b`)},
		{code: "pa", query: "Punjabi", pattern: regexp.MustCompile(`(?i)\bpunjabi\b`)},
		{code: "ur", query: "Urdu", pattern: regexp.MustCompile(`(?i)\burdu\b`)},
		{code: "ko", query: "Korean", pattern: regexp.MustCompile(`(?i)\b(?:korean|kor)\b`)},
		{code: "ja", query: "Japanese", pattern: regexp.MustCompile(`(?i)\b(?:japanese|jpn|jap)\b`)},
		{code: "zh", query: "Chinese", pattern: regexp.MustCompile(`(?i)\b(?:chinese|mandarin|cantonese)\b`)},
		{code: "fr", query: "French", pattern: regexp.MustCompile(`(?i)\b(?:french|vostfr)\b`)},
		{code: "de", query: "German", pattern: regexp.MustCompile(`(?i)\b(?:german|deutsch)\b`)},
		{code: "es", query: "Spanish", pattern: regexp.MustCompile(`(?i)\b(?:spanish|latino|castellano)\b`)},
		{code: "pt", query: "Portuguese", pattern: regexp.MustCompile(`(?i)\b(?:portuguese|português|brazilian)\b`)},
		{code: "ru", query: "Russian", pattern: regexp.MustCompile(`(?i)\brussian\b`)},
		{code: "it", query: "Italian", pattern: regexp.MustCompile(`(?i)\bitalian\b`)},
		{code: "tr", query: "Turkish", pattern: regexp.MustCompile(`(?i)\bturkish\b`)},
		{code: "ar", query: "Arabic", pattern: regexp.MustCompile(`(?i)\barabic\b`)},
		{code: "pl", query: "Polish", pattern: regexp.MustCompile(`(?i)\bpolish\b`)},
		{code: "th", query: "Thai", pattern: regexp.MustCompile(`(?i)\bthai\b`)},
		{code: "id", query: "Indonesian", pattern: regexp.MustCompile(`(?i)\b(?:indonesian|bahasa)\b`)},
		{code: "vi", query: "Vietnamese", pattern: regexp.MustCompile(`(?i)\b(?:vietnamese|viet)\b`)},
		{code: "uk", query: "Ukrainian", pattern: regexp.MustCompile(`(?i)\bukrainian\b`)},
		{code: "fa", query: "Persian", pattern: regexp.MustCompile(`(?i)\b(?:persian|farsi)\b`)},
		{code: "nl", query: "Dutch", pattern: regexp.MustCompile(`(?i)\bdutch\b`)},
	}
	subtitlePattern   = regexp.MustCompile(`(?i)\b(?:e-?subs?|eng(?:lish)?[ ._-]*subs?|subbed|softsub(?:bed)?|multi[ ._-]*subs?)\b`)
	multiAudioPattern = regexp.MustCompile(`(?i)\b(?:dual(?:[ ._-]*audio)?|multi(?:[ ._-]*(?:audio|dub(?:bed)?|language))?)\b`)
	dubbedPattern     = regexp.MustCompile(`(?i)\b(?:dub|dubbed|eng(?:lish)?[ ._-]*dub(?:bed)?|hindi[ ._-]*dub(?:bed)?)\b`)
	rawAnimePattern   = regexp.MustCompile(`(?i)\braws?\b`)
	subGroupPattern   = regexp.MustCompile(`(?i)\b(?:subsplease|erai-raws|horriblesubs|commie|doki|ember)\b`)
)

func releaseLanguageRank(request Request, release prowlarrRelease) (int, bool) {
	remainder := releaseTitleRemainder(request, release.Title)
	if request.Kind == KindAnime {
		// Anime indexers commonly use their language metadata for subtitles, so
		// audio decisions must come from release tags instead.
		return animeLanguageRank(request.OriginalLanguage, remainder)
	}
	return movieTVLanguageRank(request.OriginalLanguage, remainder, release.Languages)
}

func animeLanguageRank(originalLanguage, remainder string) (int, bool) {
	audioRank, allowed := originalAudioRank(originalLanguage, remainder, nil)
	if !allowed {
		return 0, false
	}
	rawCandidate := strings.ReplaceAll(strings.ToLower(remainder), "erai-raws", "")
	if rawAnimePattern.MatchString(rawCandidate) {
		return 0, false
	}
	if subtitlePattern.MatchString(remainder) || subGroupPattern.MatchString(remainder) {
		return max(audioRank, 2), true
	}
	return audioRank, true
}

func movieTVLanguageRank(originalLanguage, remainder string, metadata []prowlarrLanguage) (int, bool) {
	return originalAudioRank(originalLanguage, remainder, metadata)
}

func originalAudioRank(originalLanguage, remainder string, metadata []prowlarrLanguage) (int, bool) {
	titleWithoutSubtitles := subtitlePattern.ReplaceAllString(remainder, " ")
	if multiAudioPattern.MatchString(titleWithoutSubtitles) || dubbedPattern.MatchString(titleWithoutSubtitles) {
		return 0, false
	}

	languages := make(map[languageCode]struct{})
	for _, language := range metadata {
		addDetectedLanguages(languages, language.Name)
	}
	addDetectedLanguages(languages, titleWithoutSubtitles)

	original := normalizeLanguage(originalLanguage)
	if len(languages) > 1 {
		return 0, false
	}
	if len(languages) == 1 {
		if original == "" {
			return 2, true
		}
		if _, matches := languages[original]; !matches {
			return 0, false
		}
		return 2, true
	}

	// Untagged scene and anime releases normally retain the source language.
	return 1, true
}

func releaseTitleRemainder(request Request, title string) string {
	remainder := strings.ToLower(title)
	knownTitles := append([]string{request.Title}, request.Aliases...)
	for _, knownTitle := range knownTitles {
		knownTitle = strings.TrimSpace(strings.ToLower(knownTitle))
		if knownTitle != "" {
			remainder = strings.ReplaceAll(remainder, knownTitle, " ")
		}
	}
	return remainder
}

func addDetectedLanguages(languages map[languageCode]struct{}, value string) {
	for _, candidate := range languagePatterns {
		if candidate.pattern.MatchString(value) {
			languages[candidate.code] = struct{}{}
		}
	}
}

func normalizeLanguage(value string) languageCode {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "jp" {
		return "ja"
	}
	for _, candidate := range languagePatterns {
		if candidate.pattern.MatchString(value) {
			return candidate.code
		}
	}
	if len(value) >= 2 && value[0] >= 'a' && value[0] <= 'z' && value[1] >= 'a' && value[1] <= 'z' {
		return languageCode(value[:2])
	}
	return ""
}

func queryLanguageHint(request Request) string {
	if request.Kind == KindAnime {
		return ""
	}
	original := normalizeLanguage(request.OriginalLanguage)
	if original == "" || original == languageEnglish {
		return ""
	}
	for _, candidate := range languagePatterns {
		if candidate.code == original {
			return candidate.query
		}
	}
	return ""
}
