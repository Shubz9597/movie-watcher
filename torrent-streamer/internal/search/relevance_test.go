package search

import (
	"fmt"
	"testing"
)

// Adversarial relevance audit: after Prowlarr returns results, every release
// is validated against the requested title, year, season, and episode BEFORE
// seeder ranking can promote it. These tests attack the classifier the way
// real indexers mislabel releases.

func hashes(ids ...rune) []prowlarrRelease {
	releases := make([]prowlarrRelease, 0, len(ids))
	for _, id := range ids {
		releases = append(releases, prowlarrRelease{
			Title:    "filler",
			Indexer:  "test",
			Protocol: "torrent",
			InfoHash: idHex(id),
		})
	}
	return releases
}

func idHex(id rune) string {
	// 40-char lowercase hex derived from the codepoint — always a VALID
	// info hash (non-hex filler would be dropped by normalizeHash, which is
	// correct production behavior and would mask the classifier under test).
	return fmt.Sprintf("%040x", int64(id))
}

func TestMovieWrongTitleRejected(t *testing.T) {
	t.Parallel()
	service := newTestService(t, "http://127.0.0.1:9696")
	request := Request{Kind: KindMovie, Title: "Example", Year: 2026}

	// Titles with NO significant overlap with the request are rejected even
	// with massive swarms. (Sequels that contain the title words AND share
	// the requested year cannot be separated by title alone — that is the
	// accepted ambiguity boundary; the year check owns remakes.)
	wrongTitles := []string{
		"Exampled 2026 1080p",              // different word entirely
		"Unrelated Blockbuster 2026 1080p", // wrong title, massive seeders
		"Example Restart 2019 1080p",       // wrong year edition
	}
	releases := []prowlarrRelease{
		{Title: "Example 2026 1080p", Indexer: "test", Protocol: "torrent", InfoHash: idHex('a'), Seeders: 10},
	}
	for _, title := range wrongTitles {
		releases = append(releases, prowlarrRelease{
			Title: title, Indexer: "test", Protocol: "torrent", InfoHash: idHex(rune(len(title))), Seeders: 5000,
		})
	}

	results := service.normalize(request, releases)
	if len(results) != 1 {
		t.Fatalf("len(normalize(wrong titles)) = %d, want only the exact-title release", len(results))
	}
	if results[0].Title != "Example 2026 1080p" {
		t.Errorf("survivor = %q, want the requested title", results[0].Title)
	}
}

func TestMovieTitleNormalizationGaps(t *testing.T) {
	t.Parallel()
	service := newTestService(t, "http://127.0.0.1:9696")

	// "Movie, The" ordering, "&" vs "and", accents, and dropped connectives
	// are scene-naming reality: each must still match (v1 regression guard —
	// the strict sequence matcher rejected all of these and produced ZERO
	// torrents for whole classes of titles).
	cases := []struct {
		request  Request
		release  string
		fallback string // a guaranteed-correct release expected alongside
	}{
		{Request{Kind: KindMovie, Title: "The Movie", Year: 2023}, "Movie, The 2023 1080p", "The Movie 2023 1080p"},
		{Request{Kind: KindMovie, Title: "Movie, The", Year: 2023}, "The Movie 2023 1080p", "Movie, The 2023 1080p"},
		{Request{Kind: KindMovie, Title: "Dungeons & Dragons", Year: 2023}, "Dungeons and Dragons 2023 1080p", "Dungeons & Dragons 2023 1080p"},
		{Request{Kind: KindMovie, Title: "Amélie", Year: 2001}, "Amelie 2001 1080p", "Amélie 2001 1080p"},
		{Request{Kind: KindMovie, Title: "Doctor Strange in the Multiverse of Madness", Year: 2022}, "Doctor Strange Multiverse of Madness 2022 1080p", "Doctor Strange in the Multiverse of Madness 2022 1080p"},
	}
	for _, c := range cases {
		results := service.normalize(c.request, []prowlarrRelease{
			{Title: c.release, Indexer: "test", Protocol: "torrent", InfoHash: idHex(rune(len(c.release))), Seeders: 20},
			{Title: c.fallback, Indexer: "test", Protocol: "torrent", InfoHash: idHex(rune(len(c.fallback))), Seeders: 10},
		})
		if len(results) != 2 {
			t.Errorf("normalize(%q, %q) = %d results, want both releases to survive", c.request.Title, c.release, len(results))
		}
	}
}

func TestMovieRemakeRejectedByExplicitYear(t *testing.T) {
	t.Parallel()
	service := newTestService(t, "http://127.0.0.1:9696")
	request := Request{Kind: KindMovie, Title: "The Lion King", Year: 1994}

	results := service.normalize(request, []prowlarrRelease{
		{Title: "The Lion King 2019 1080p", Indexer: "test", Protocol: "torrent", InfoHash: idHex('1'), Seeders: 900}, // remake
		{Title: "The Lion King 1994 720p", Indexer: "test", Protocol: "torrent", InfoHash: idHex('2'), Seeders: 30},  // requested
	})
	if len(results) != 1 {
		t.Fatalf("len(normalize(remake)) = %d, want the 1994 release only", len(results))
	}
	if !results[0].verified {
		t.Errorf("survivor %q verified = false, want true (explicit year match)", results[0].Title)
	}
	if results[0].Title != "The Lion King 1994 720p" {
		t.Errorf("survivor = %q, want the 1994 release", results[0].Title)
	}
}

func TestMovieTitleEmbeddedYearIsNotReleaseYear(t *testing.T) {
	t.Parallel()
	service := newTestService(t, "http://127.0.0.1:9696")
	// "2049" is part of the requested TITLE: it must not be read as the
	// release year and reject the movie.
	request := Request{Kind: KindMovie, Title: "Blade Runner 2049", Year: 2017}

	results := service.normalize(request, []prowlarrRelease{
		{Title: "Blade Runner 2049 2017 1080p", Indexer: "test", Protocol: "torrent", InfoHash: idHex('b'), Seeders: 50},
	})
	if len(results) != 1 {
		t.Fatalf("len(normalize(title-embedded year)) = %d, want 1", len(results))
	}
	if !results[0].verified {
		t.Errorf("verified = false, want true (release year 2017 matches)")
	}
}

func TestMovieAmbiguousYearNeverRejects(t *testing.T) {
	t.Parallel()
	service := newTestService(t, "http://127.0.0.1:9696")
	request := Request{Kind: KindMovie, Title: "Example"}

	// No explicit year anywhere: ambiguous, kept (never promoted above a
	// verified release).
	results := service.normalize(request, []prowlarrRelease{
		{Title: "Example 1080p", Indexer: "test", Protocol: "torrent", InfoHash: idHex('c'), Seeders: 10},
	})
	if len(results) != 1 || results[0].verified {
		t.Fatalf("normalize(no year) = %v, want one ambiguous result", results)
	}
}

func TestTVWrongEpisodeRejected(t *testing.T) {
	t.Parallel()
	service := newTestService(t, "http://127.0.0.1:9696")
	season, episode := 1, 3
	request := Request{Kind: KindTV, Title: "Example Show", Season: &season, Episode: &episode}

	results := service.normalize(request, []prowlarrRelease{
		{Title: "Example Show S01E01 1080p", Indexer: "test", Protocol: "torrent", InfoHash: idHex('1'), Seeders: 400}, // wrong episode
		{Title: "Example Show S01E05 1080p", Indexer: "test", Protocol: "torrent", InfoHash: idHex('2'), Seeders: 300}, // wrong episode
		{Title: "Example Show S02E03 1080p", Indexer: "test", Protocol: "torrent", InfoHash: idHex('3'), Seeders: 200}, // wrong season
		{Title: "Example Show S01E03 1080p", Indexer: "test", Protocol: "torrent", InfoHash: idHex('4'), Seeders: 2},   // the match
	})
	if len(results) != 1 {
		t.Fatalf("len(normalize(wrong episodes)) = %d, want the requested episode only", len(results))
	}
	if results[0].Title != "Example Show S01E03 1080p" {
		t.Errorf("survivor = %q, want the requested S01E03", results[0].Title)
	}
	if !results[0].verified {
		t.Errorf("verified = false, want true")
	}
}

func TestTVNoFallbackWhenNothingMatches(t *testing.T) {
	t.Parallel()
	service := newTestService(t, "http://127.0.0.1:9696")
	season, episode := 1, 99
	request := Request{Kind: KindTV, Title: "Example Show", Season: &season, Episode: &episode}

	results := service.normalize(request, []prowlarrRelease{
		{Title: "Example Show S01E01 1080p", Indexer: "test", Protocol: "torrent", InfoHash: idHex('1'), Seeders: 400},
		{Title: "Example Show S01E02 1080p", Indexer: "test", Protocol: "torrent", InfoHash: idHex('2'), Seeders: 300},
		{Title: "Example Show 1080p", Indexer: "test", Protocol: "torrent", InfoHash: idHex('3'), Seeders: 100}, // ambiguous
	})
	if len(results) != 0 {
		t.Fatalf("len(normalize(nothing matches)) = %d, want 0 (never fall back to all releases)", len(results))
	}
}

func TestTVMislabeledPackRejected(t *testing.T) {
	t.Parallel()
	service := newTestService(t, "http://127.0.0.1:9696")
	season, episode := 1, 5
	request := Request{Kind: KindTV, Title: "Example Show", Season: &season, Episode: &episode}

	results := service.normalize(request, []prowlarrRelease{
		// Season pack of the WRONG season: the label contradicts the request.
		{Title: "Example Show S02 Complete Season Pack 1080p", Indexer: "test", Protocol: "torrent", InfoHash: idHex('1'), Seeders: 800},
		// Range pack that provably does not contain episode 5.
		{Title: "Example Show S01 E01-E04 1080p", Indexer: "test", Protocol: "torrent", InfoHash: idHex('2'), Seeders: 700},
		// Verified season pack of the requested season.
		{Title: "Example Show S01 Complete 1080p", Indexer: "test", Protocol: "torrent", InfoHash: idHex('3'), Seeders: 40},
		// Verified range pack covering the episode.
		{Title: "Example Show S01 E01-E12 1080p", Indexer: "test", Protocol: "torrent", InfoHash: idHex('4'), Seeders: 60},
	})
	if len(results) != 2 {
		t.Fatalf("len(normalize(mislabeled packs)) = %d, want only the S01 packs", len(results))
	}
	for _, result := range results {
		if !result.verified {
			t.Errorf("pack %q verified = false, want true (coverage confirmed)", result.Title)
		}
	}
}

func TestAmbiguousNeverOutranksVerified(t *testing.T) {
	t.Parallel()
	service := newTestService(t, "http://127.0.0.1:9696")
	request := Request{Kind: KindMovie, Title: "Example", Year: 2026}

	results := service.normalize(request, []prowlarrRelease{
		// Ambiguous: no year, colossal swarm.
		{Title: "Example 1080p", Indexer: "test", Protocol: "torrent", InfoHash: idHex('1'), Seeders: 5000},
		// Verified: explicit year match, tiny swarm.
		{Title: "Example 2026 720p", Indexer: "test", Protocol: "torrent", InfoHash: idHex('2'), Seeders: 3},
	})
	if len(results) != 2 {
		t.Fatalf("len(normalize(mixed)) = %d, want both (ambiguous kept, ranked below)", len(results))
	}
	if !results[0].verified || results[1].verified {
		t.Fatalf("order = [%q verified=%t, %q verified=%t], want verified first", results[0].Title, results[0].verified, results[1].Title, results[1].verified)
	}
}

func TestIndexerImdbIDBypassesNoisyTitle(t *testing.T) {
	t.Parallel()
	service := newTestService(t, "http://127.0.0.1:9696")
	request := Request{Kind: KindMovie, Title: "Example", Year: 2026, IMDBID: "tt1234567"}

	results := service.normalize(request, []prowlarrRelease{
		// Release title does not contain the requested title, but the indexer
		// resolved its imdbId: authoritative, kept.
		{Title: "Exmple.2026.1080p", Indexer: "test", Protocol: "torrent", InfoHash: idHex('1'), Seeders: 10, ImdbID: "tt1234567"},
		{Title: "Different Movie 2026 1080p", Indexer: "test", Protocol: "torrent", InfoHash: idHex('2'), Seeders: 999, ImdbID: "tt9999999"},
	})
	if len(results) != 1 {
		t.Fatalf("len(normalize(imdb bypass)) = %d, want the imdb-matched release only", len(results))
	}
}

func TestTVTitleLevelSeasonEvidence(t *testing.T) {
	t.Parallel()
	service := newTestService(t, "http://127.0.0.1:9696")
	season := 2
	request := Request{Kind: KindTV, Title: "Example Show", Season: &season}

	results := service.normalize(request, []prowlarrRelease{
		{Title: "Example Show S02 1080p", Indexer: "test", Protocol: "torrent", InfoHash: idHex('1'), Seeders: 10},   // verified
		{Title: "Example Show S01 1080p", Indexer: "test", Protocol: "torrent", InfoHash: idHex('2'), Seeders: 999}, // wrong season → rejected
		{Title: "Example Show Season Pack 1080p", Indexer: "test", Protocol: "torrent", InfoHash: idHex('3'), Seeders: 5}, // unverifiable → ambiguous
	})
	if len(results) != 2 {
		t.Fatalf("len(normalize(title-level season)) = %d, want verified + ambiguous", len(results))
	}
	if results[0].Title != "Example Show S02 1080p" || !results[0].verified {
		t.Errorf("first = %q verified=%t, want the verified S02 release first", results[0].Title, results[0].verified)
	}
}
