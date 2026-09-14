package catalog

import (
	"sort"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// Search normalization must retain non-Latin scripts and season numbers;
// the more aggressive identity-merge normalization is unsuitable here.
func normalizeSearchText(value string) string {
	var result strings.Builder
	for _, char := range norm.NFKD.String(strings.ToLower(value)) {
		switch {
		case unicode.Is(unicode.Mn, char):
			continue
		case unicode.IsLetter(char) || unicode.IsNumber(char):
			result.WriteRune(char)
		default:
			result.WriteByte(' ')
		}
	}
	return strings.Join(strings.Fields(result.String()), " ")
}

func searchMatchScore(title, query string) int {
	title = normalizeSearchText(title)
	if title == "" || query == "" {
		return 0
	}
	if title == query {
		return 4
	}
	if strings.HasPrefix(title, query+" ") {
		return 3
	}
	tokens := " " + title + " "
	allTokens := true
	for _, token := range strings.Fields(query) {
		if !strings.Contains(tokens, " "+token+" ") {
			allTokens = false
			break
		}
	}
	if allTokens {
		return 2
	}
	if strings.Contains(title, query) {
		return 1
	}
	return 0
}

// MergeTitles chooses canonical identities deterministically, but its ID
// ordering is not relevance. Rank after merging, before applying the limit.
// Equal text matches retain provider priority and upstream relevance order.
func rankSearchTitles(titles []Title, query string, groups [][]Title) {
	query = normalizeSearchText(query)
	providerOrder := make(map[string]int)
	position := 0
	for _, group := range groups {
		for _, title := range group {
			if _, exists := providerOrder[title.ID]; !exists {
				providerOrder[title.ID] = position
			}
			position++
		}
	}
	scores := make(map[string]int, len(titles))
	for _, title := range titles {
		scores[title.ID] = max(searchMatchScore(title.Title, query), searchMatchScore(title.OriginalTitle, query))
	}
	sort.SliceStable(titles, func(i, j int) bool {
		left, right := titles[i].ID, titles[j].ID
		if scores[left] != scores[right] {
			return scores[left] > scores[right]
		}
		return providerOrder[left] < providerOrder[right]
	})
}
