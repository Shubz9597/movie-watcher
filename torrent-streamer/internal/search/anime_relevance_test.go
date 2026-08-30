package search

import "testing"

func TestAnimeReleaseRelevant(t *testing.T) {
	t.Parallel()

	season := 1
	request := Request{
		Kind:    KindAnime,
		Title:   "Frieren: Beyond Journey's End",
		Aliases: []string{"Sousou no Frieren", "葬送のフリーレン"},
		Season:  &season,
	}
	tests := []struct {
		name  string
		title string
		want  bool
	}{
		{name: "romanized alias", title: "[SubsPlease] Sousou no Frieren - 02 (1080p)", want: true},
		{name: "canonical punctuation variant", title: "Frieren Beyond Journeys End - 02", want: true},
		{name: "native alias", title: "葬送のフリーレン - 02", want: true},
		{name: "wrong Frieren season", title: "[Erai-raws] Sousou no Frieren 2nd Season - 02 (1080p)", want: false},
		{name: "wrong anime", title: "[SubsPlease] Link Click S3 - 02 (1080p)", want: false},
		{name: "unrelated numbered release", title: "[Erai-raws] Bleach: Sennen Kessen-hen - 02", want: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			got := animeReleaseRelevant(request, test.title)
			if got != test.want {
				t.Errorf("animeReleaseRelevant(%q, %q) = %t, want %t", request.Title, test.title, got, test.want)
			}
		})
	}
}

func TestAnimeReleaseRelevantPrefersRequestedSeason(t *testing.T) {
	t.Parallel()

	metadataSeason := 1
	request := Request{
		Kind:    KindAnime,
		Title:   "Frieren: Beyond Journey's End Season 2",
		Aliases: []string{"Sousou no Frieren 2nd Season"},
		Season:  &metadataSeason,
	}
	tests := []struct {
		name  string
		title string
		want  bool
	}{
		{name: "mismatched S2 release", title: "[SubsPlease] Sousou no Frieren S2 - 02", want: false},
		{name: "mismatched ordinal release", title: "Sousou no Frieren 2nd Season - 02", want: false},
		{name: "matching S1 release", title: "Sousou no Frieren S1 - 02", want: true},
		{name: "seasonless release", title: "Sousou no Frieren - 02", want: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			got := animeReleaseRelevant(request, test.title)
			if got != test.want {
				t.Errorf("animeReleaseRelevant(%q, %q) = %t, want %t", request.Title, test.title, got, test.want)
			}
		})
	}
}

func TestNormalizeFiltersAnimeTitleAndSeason(t *testing.T) {
	t.Parallel()

	service := newTestService(t, "http://127.0.0.1:9696")
	season := 1
	episode := 2
	request := Request{
		Kind:             KindAnime,
		Title:            "Frieren: Beyond Journey's End",
		Aliases:          []string{"Sousou no Frieren", "葬送のフリーレン"},
		Season:           &season,
		Episode:          &episode,
		Absolute:         &episode,
		OriginalLanguage: "ja",
	}
	releases := []prowlarrRelease{
		{Title: "[SubsPlease] Sousou no Frieren - 02 (1080p)", Indexer: "Nyaa.si", Protocol: "torrent", InfoHash: "1111111111111111111111111111111111111111", Seeders: 100},
		{Title: "[Erai-raws] Sousou no Frieren 2nd Season - 02 (1080p)", Indexer: "LimeTorrents", Protocol: "torrent", InfoHash: "2222222222222222222222222222222222222222", Seeders: 200},
		{Title: "[SubsPlease] Link Click S3 - 02 (1080p)", Indexer: "TheRARBG", Protocol: "torrent", InfoHash: "3333333333333333333333333333333333333333", Seeders: 300},
	}

	results := service.normalize(request, releases)
	if len(results) != 1 {
		t.Fatalf("len(normalize(Frieren episode 2)) = %d, want 1", len(results))
	}
	if got, want := results[0].Title, releases[0].Title; got != want {
		t.Errorf("normalize(Frieren episode 2)[0].Title = %q, want %q", got, want)
	}
}
