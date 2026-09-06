package catalog

import (
	"testing"
)

func TestNormalizeTitleMatchesRendererCharacterization(t *testing.T) {
	cases := map[string]string{
		"Frieren: Beyond Journey's End!":           "frieren beyond journey s end",
		"Frieren — Season 1 Part 2":                "frieren",
		"Re:Zero − Starting Life in Another World": "re zero starting life in another world",
		"One-Punch Man Season 2":                   "one punch man",
		// The renderer's merge key regex ([^a-z0-9]+) strips non-ASCII too;
		// characterized behavior, kept identical in Go.
		"葬送のフリーレン": "",
	}
	for input, want := range cases {
		if got := NormalizeTitle(input); got != want {
			t.Fatalf("NormalizeTitle(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestMergeTitlesPriorityWinsAndAccumulatesProviders(t *testing.T) {
	tmdb := Title{
		ID: "tmdb:209867", Type: TypeAnime, Title: "Frieren: Beyond Journey's End", OriginalTitle: "葬送のフリーレン",
		Year: 2023, Overview: "tmdb overview",
		Artwork:     map[string]string{"poster": "tmdb-poster"},
		ProviderIDs: map[string]string{"tmdb": "209867"}, MergedFrom: []string{"tmdb"},
	}
	anilist := Title{
		ID: "anilist:154587", Type: TypeAnime, Title: "Frieren: Beyond Journey's End",
		Year: 2023, Overview: "anilist overview", IMDBID: "tt28015436",
		Artwork:     map[string]string{"poster": "anilist-poster", "background": "anilist-bg"},
		ProviderIDs: map[string]string{"anilist": "154587", "jikan": "52991"}, MergedFrom: []string{"anilist"},
	}
	merged := MergeTitles([][]Title{{tmdb}, {anilist}})
	if len(merged) != 1 {
		t.Fatalf("titles did not join: %d entries", len(merged))
	}
	joined := merged[0]
	if joined.ID != "tmdb:209867" {
		t.Fatalf("highest-priority id must win: %q", joined.ID)
	}
	if joined.Title != "Frieren: Beyond Journey's End" || joined.OriginalTitle != "葬送のフリーレン" || joined.Overview != "tmdb overview" {
		t.Fatalf("priority fields wrong: %+v", joined)
	}
	if joined.IMDBID != "tt28015436" {
		t.Fatalf(" imdb enrichment lost: %+v", joined)
	}
	if joined.Artwork["poster"] != "tmdb-poster" || joined.Artwork["background"] != "anilist-bg" {
		t.Fatalf("artwork merge wrong: %v", joined.Artwork)
	}
	for _, provider := range []string{"tmdb", "anilist", "jikan"} {
		if joined.ProviderIDs[provider] == "" {
			t.Fatalf("providerIds missing %q: %v", provider, joined.ProviderIDs)
		}
	}
	if len(joined.MergedFrom) != 2 || joined.MergedFrom[0] != "tmdb" || joined.MergedFrom[1] != "anilist" {
		t.Fatalf("mergedFrom = %v", joined.MergedFrom)
	}
}

func TestMergeTitlesDifferentYearsDoNotJoin(t *testing.T) {
	a := Title{ID: "tmdb:1", Type: TypeMovie, Title: "Show", Year: 2022, ProviderIDs: map[string]string{"tmdb": "1"}, MergedFrom: []string{"tmdb"}}
	b := Title{ID: "jikan:9", Type: TypeMovie, Title: "Show", Year: 2023, ProviderIDs: map[string]string{"jikan": "9"}, MergedFrom: []string{"jikan"}}
	merged := MergeTitles([][]Title{{a}, {b}})
	if len(merged) != 2 {
		t.Fatalf("different years must not join: %d", len(merged))
	}
}

func TestMergeTitlesAmbiguousWithinProviderResolvesLexicographically(t *testing.T) {
	// Same provider returns two candidates that collide on the join key.
	high := Title{ID: "tmdb:100", Type: TypeMovie, Title: "Show", Year: 2020, ProviderIDs: map[string]string{"tmdb": "100"}, MergedFrom: []string{"tmdb"}}
	low := Title{ID: "tmdb:50", Type: TypeMovie, Title: "Show", Year: 2020, ProviderIDs: map[string]string{"tmdb": "50"}, MergedFrom: []string{"tmdb"}}
	for iteration := 0; iteration < 20; iteration++ {
		group := []Title{high, low}
		if iteration%2 == 1 {
			group = []Title{low, high}
		}
		merged := MergeTitles([][]Title{group})
		if len(merged) != 1 || merged[0].ID != "tmdb:100" {
			t.Fatalf("ambiguous join not resolved by lexicographic id order: %+v", merged)
		}
	}
}

func TestMergeTitlesDeterministicAcrossProviderOrderingsOfSamePriority(t *testing.T) {
	p1a := Title{ID: "tmdb:1", Type: TypeMovie, Title: "Alpha", Year: 2021, ProviderIDs: map[string]string{"tmdb": "1"}, MergedFrom: []string{"tmdb"}}
	p1b := Title{ID: "tmdb:2", Type: TypeMovie, Title: "Beta", Year: 2021, ProviderIDs: map[string]string{"tmdb": "2"}, MergedFrom: []string{"tmdb"}}
	merged := MergeTitles([][]Title{{p1b, p1a}})
	if merged[0].ID != "tmdb:1" || merged[1].ID != "tmdb:2" {
		t.Fatalf("within-provider order must be lexicographic: %v", merged)
	}
}

func TestMergeEpisodesPriorityAndUnion(t *testing.T) {
	tmdb := Episode{ID: "tmdb:209867:1:1", Season: 1, Episode: 1, Title: "tmdb title", AirDate: "2023-09-29", ProviderIDs: map[string]string{"tmdb": "209867"}}
	anizip := Episode{ID: "anizip:154587:1:1", Season: 1, Episode: 1, Title: "anizip title", Overview: "anizip overview", DurationS: 1440, ProviderIDs: map[string]string{"anizip": "154587"}}
	merged := MergeEpisodes([][]Episode{{tmdb}, {anizip}})
	if len(merged) != 1 {
		t.Fatalf("episodes did not join")
	}
	joined := merged[0]
	if joined.Title != "tmdb title" || joined.AirDate != "2023-09-29" {
		t.Fatalf("priority fields wrong: %+v", joined)
	}
	if joined.Overview != "anizip overview" || joined.DurationS != 1440 {
		t.Fatalf("enrichment lost: %+v", joined)
	}
	if joined.ProviderIDs["tmdb"] == "" || joined.ProviderIDs["anizip"] == "" {
		t.Fatalf("providerIds union wrong: %v", joined.ProviderIDs)
	}
}
