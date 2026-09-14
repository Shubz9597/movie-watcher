package catalog

import (
	"context"
	"testing"
)

func TestSearchRanksExactTitleBeforeExtrasAndAppliesLimit(t *testing.T) {
	provider := &fakeProvider{name: "tmdb", searchFn: func(context.Context, SearchQuery) ([]Title, error) {
		return []Title{
			{ID: "tmdb:movie:1", Type: TypeMovie, Title: "Interstellar: The Science"},
			{ID: "tmdb:movie:2", Type: TypeMovie, Title: "Journey to Interstellar Space"},
			{ID: "tmdb:movie:157336", Type: TypeMovie, Title: "Interstellar", Year: 2014},
		}, nil
	}}
	service := NewService([]Provider{provider}, Options{})
	// Repeat through the cache: both paths must use query relevance.
	for i := 0; i < 2; i++ {
		result := service.Search(context.Background(), SearchQuery{Query: " INTERSTELLAR ", Limit: 1})
		if len(result.Titles) != 1 || result.Titles[0].ID != "tmdb:movie:157336" {
			t.Fatalf("exact title was not first: %+v", result.Titles)
		}
	}
}

func TestSearchRankPreservesProviderOrderForEqualMatches(t *testing.T) {
	groups := [][]Title{{
		{ID: "tmdb:movie:90", Title: "Interstellar", Year: 2014},
		{ID: "tmdb:movie:1", Title: "Interstellar", Year: 2020},
	}}
	titles := MergeTitles(groups)
	rankSearchTitles(titles, "interstellar", groups)
	if titles[0].ID != "tmdb:movie:90" {
		t.Fatalf("lost upstream relevance for equal matches: %+v", titles)
	}
}

func TestSearchCacheSeparatesResultLimits(t *testing.T) {
	provider := &fakeProvider{name: "tmdb", searchFn: func(_ context.Context, query SearchQuery) ([]Title, error) {
		rows := []Title{{ID: "tmdb:1", Title: "Space"}, {ID: "tmdb:2", Title: "Space Travel"}}
		return rows[:min(query.Limit, len(rows))], nil
	}}
	service := NewService([]Provider{provider}, Options{})
	service.Search(context.Background(), SearchQuery{Query: "space", Limit: 1})
	result := service.Search(context.Background(), SearchQuery{Query: "space", Limit: 2})
	if len(result.Titles) != 2 {
		t.Fatalf("smaller cached result hid available results: %+v", result.Titles)
	}
}

func TestSearchMatchNormalization(t *testing.T) {
	for _, test := range []struct {
		title, query string
		score        int
	}{
		{"Amélie", "amelie", 4},
		{"進撃の巨人", "進撃の巨人", 4},
		{"Naruto Season 2", "Naruto Season 2", 4},
		{"Naruto Season 1", "Naruto Season 2", 0},
		{"Interstellar: The Science", "Interstellar", 3},
		{"The Science of Interstellar", "Interstellar", 2},
		{"Interstellar", "stellar", 1},
		{"Anything", "", 0},
	} {
		if got := searchMatchScore(test.title, normalizeSearchText(test.query)); got != test.score {
			t.Errorf("%q for %q: got %d, want %d", test.title, test.query, got, test.score)
		}
	}
	groups := [][]Title{{{ID: "tmdb:1", Title: "別の映画", Year: 2020}, {ID: "tmdb:2", Title: "星際效應", OriginalTitle: "Interstellar", Year: 2014}}}
	titles := MergeTitles(groups)
	rankSearchTitles(titles, "Interstellar", groups)
	if titles[0].ID != "tmdb:2" {
		t.Fatal("original title should contribute to search relevance")
	}
}
