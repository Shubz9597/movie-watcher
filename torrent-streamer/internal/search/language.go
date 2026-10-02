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
)

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
