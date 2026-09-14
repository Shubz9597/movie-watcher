package search

import (
	"strings"
	"testing"
)

func TestReleaseLanguageRankMovieAndTV(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name             string
		originalLanguage string
		title            string
		metadata         []prowlarrLanguage
		wantRank         int
		wantAllowed      bool
	}{
		{name: "untagged english original", originalLanguage: "en", title: "Example 1080p", wantRank: 1, wantAllowed: true},
		{name: "english original rejects Hindi", originalLanguage: "en", title: "Example [Hindi] 1080p", wantAllowed: false},
		{name: "english subtitles are not audio", originalLanguage: "en", title: "Example ESubs 1080p", wantRank: 1, wantAllowed: true},
		{name: "multiple subtitles are not multiple audio", originalLanguage: "en", title: "Example Multi Subs 1080p", wantRank: 1, wantAllowed: true},
		{name: "hindi original accepts untagged native audio", originalLanguage: "hi", title: "Example 1080p", wantRank: 1, wantAllowed: true},
		{name: "hindi original prefers explicit Hindi", originalLanguage: "hi", title: "Example [Hindi] 1080p", wantRank: 2, wantAllowed: true},
		{name: "hindi original rejects English", originalLanguage: "hi", title: "Example English Audio 1080p", wantAllowed: false},
		{name: "hindi original rejects dubbed release", originalLanguage: "hi", title: "Example Hindi Dubbed 1080p", wantAllowed: false},
		{name: "hindi original rejects dual audio", originalLanguage: "hi", title: "Example Hindi English Dual Audio", wantAllowed: false},
		{name: "korean original accepts untagged native audio", originalLanguage: "ko", title: "Example 1080p", wantRank: 1, wantAllowed: true},
		{name: "korean original prefers explicit Korean", originalLanguage: "ko", title: "Example Korean 1080p", wantRank: 2, wantAllowed: true},
		{name: "korean original rejects English dub", originalLanguage: "ko", title: "Example English Dubbed 1080p", wantAllowed: false},
		{name: "spanish original accepts Spanish", originalLanguage: "es", title: "Example Spanish 1080p", wantRank: 2, wantAllowed: true},
		{name: "spanish original rejects English", originalLanguage: "es", title: "Example English Audio 1080p", wantAllowed: false},
		{name: "metadata language is honored", originalLanguage: "en", title: "Example 1080p", metadata: []prowlarrLanguage{{Name: "Hindi"}}, wantAllowed: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			request := Request{Kind: KindMovie, Title: "Example", OriginalLanguage: test.originalLanguage}
			release := prowlarrRelease{Title: test.title, Languages: test.metadata}
			gotRank, gotAllowed := releaseLanguageRank(request, release)
			if gotRank != test.wantRank || gotAllowed != test.wantAllowed {
				t.Errorf("releaseLanguageRank(%q, %q) = (%d, %t), want (%d, %t)", test.originalLanguage, test.title, gotRank, gotAllowed, test.wantRank, test.wantAllowed)
			}
		})
	}
}

func TestReleaseLanguageRankAnime(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		title       string
		wantRank    int
		wantAllowed bool
	}{
		{name: "subsplease original audio", title: "[SubsPlease] Example - 02", wantRank: 2, wantAllowed: true},
		{name: "erai raws is a subtitling group", title: "[Erai-raws] Example - 02", wantRank: 2, wantAllowed: true},
		{name: "explicitly subbed", title: "Example - 02 Eng Subs", wantRank: 2, wantAllowed: true},
		{name: "unmarked anime is allowed", title: "[Group] Example - 02", wantRank: 1, wantAllowed: true},
		{name: "english dub is rejected", title: "Example - 02 English Dubbed", wantAllowed: false},
		{name: "wrong explicit audio is rejected", title: "Example - 02 English Audio Eng Subs", wantAllowed: false},
		{name: "japanese audio is accepted", title: "Example - 02 Japanese Audio Eng Subs", wantRank: 2, wantAllowed: true},
		{name: "dual audio is rejected", title: "Example - 02 Dual Audio", wantAllowed: false},
		{name: "bare multi tag is rejected", title: "Example - 02 [MULTi]", wantAllowed: false},
		{name: "multiple subtitles are allowed", title: "Example - 02 Multi Subs", wantRank: 2, wantAllowed: true},
		{name: "raw release is rejected", title: "[Ohys-Raws] Example - 02", wantAllowed: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			request := Request{Kind: KindAnime, Title: "Example", OriginalLanguage: "ja"}
			gotRank, gotAllowed := releaseLanguageRank(request, prowlarrRelease{Title: test.title})
			if gotRank != test.wantRank || gotAllowed != test.wantAllowed {
				t.Errorf("releaseLanguageRank(anime, %q) = (%d, %t), want (%d, %t)", test.title, gotRank, gotAllowed, test.wantRank, test.wantAllowed)
			}
		})
	}
}

func TestBuildQueriesAddsLanguageHint(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		request     Request
		wantQueries int
		wantSuffix  string
	}{
		{name: "hindi movie", request: Request{Kind: KindMovie, Title: "Example", Year: 2026, OriginalLanguage: "hi"}, wantQueries: 2, wantSuffix: " Hindi"},
		{name: "korean TV in Korean", request: Request{Kind: KindTV, Title: "Example", OriginalLanguage: "ko"}, wantQueries: 2, wantSuffix: " Korean"},
		{name: "english title needs no hint", request: Request{Kind: KindMovie, Title: "Example", OriginalLanguage: "en"}, wantQueries: 1},
		{name: "anime uses release filtering", request: Request{Kind: KindAnime, Title: "Example", OriginalLanguage: "ja"}, wantQueries: 1},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			queries := buildQueries(test.request)
			if len(queries) != test.wantQueries {
				t.Fatalf("len(buildQueries(%q)) = %d, want %d", test.name, len(queries), test.wantQueries)
			}
			if test.wantSuffix != "" && !strings.HasSuffix(queries[len(queries)-1].query, test.wantSuffix) {
				t.Errorf("buildQueries(%q) last query = %q, want suffix %q", test.name, queries[len(queries)-1].query, test.wantSuffix)
			}
		})
	}
}

func TestNormalizeFiltersAndRanksAudioProfile(t *testing.T) {
	t.Parallel()

	service := newTestService(t, "http://127.0.0.1:9696")
	request := Request{Kind: KindMovie, Title: "Example", OriginalLanguage: "en"}
	releases := []prowlarrRelease{
		{Title: "Example [Hindi] 1080p", Indexer: "test", InfoHash: "1111111111111111111111111111111111111111", Seeders: 100},
		{Title: "Example 1080p", Indexer: "test", InfoHash: "2222222222222222222222222222222222222222", Seeders: 20},
		{Title: "Example English Audio 1080p", Indexer: "test", InfoHash: "3333333333333333333333333333333333333333", Seeders: 5},
	}

	results := service.normalize(request, releases)
	if len(results) != 2 {
		t.Fatalf("len(normalize(English profile)) = %d, want 2", len(results))
	}
	// Swarm health FIRST (device pass): the untagged release (which retains
	// the original language by convention) with 20 seeders outranks the
	// explicitly tagged English release with only 5 — language is a bounded
	// bonus, never a rescue for a weak swarm.
	if results[0].Title != "Example 1080p" {
		t.Errorf("normalize(English profile)[0].Title = %q, want the healthier untagged release first", results[0].Title)
	}
	for _, result := range results {
		if strings.Contains(result.Title, "Hindi") {
			t.Errorf("normalize(English profile) retained disallowed result %q", result.Title)
		}
	}

	// Language still breaks near-ties: an explicitly tagged English release
	// with 20 seeders outranks an untagged release with 5.
	nearTie := []prowlarrRelease{
		{Title: "Example 1080p", Indexer: "test", InfoHash: "4444444444444444444444444444444444444444", Seeders: 5},
		{Title: "Example English Audio 1080p", Indexer: "test", InfoHash: "5555555555555555555555555555555555555555", Seeders: 20},
	}
	ranked := service.normalize(request, nearTie)
	if len(ranked) != 2 {
		t.Fatalf("len(normalize(near-tie)) = %d, want 2", len(ranked))
	}
	if ranked[0].Title != "Example English Audio 1080p" {
		t.Errorf("normalize(near-tie)[0].Title = %q, want the tagged release when health is comparable", ranked[0].Title)
	}

	// Dead swarms are dropped when enough known-alive alternatives exist.
	dead := []prowlarrRelease{
		{Title: "Example alive 1 1080p", Indexer: "test", InfoHash: "6666666666666666666666666666666666666666", Seeders: 30},
		{Title: "Example alive 2 1080p", Indexer: "test", InfoHash: "7777777777777777777777777777777777777777", Seeders: 25},
		{Title: "Example alive 3 1080p", Indexer: "test", InfoHash: "8888888888888888888888888888888888888888", Seeders: 20},
		{Title: "Example alive 4 1080p", Indexer: "test", InfoHash: "9999999999999999999999999999999999999999", Seeders: 15},
		{Title: "Example alive 5 1080p", Indexer: "test", InfoHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Seeders: 10},
		{Title: "Example dead 1080p", Indexer: "test", InfoHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", Seeders: 0},
	}
	swept := service.normalize(request, dead)
	if len(swept) != 5 {
		t.Fatalf("len(normalize(dead)) = %d, want 5 (dead swarm filtered)", len(swept))
	}
}
