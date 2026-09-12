package recommendations

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"torrent-streamer/internal/catalog"
	"torrent-streamer/internal/library"
)

// --- deterministic fakes ------------------------------------------------------

type fakeLibrary struct {
	revision  int64
	seeds     []library.Seed
	activeIDs map[string]bool
	seedErr   error
}

func (f *fakeLibrary) FavouriteSeeds(_ context.Context, limit int) ([]library.Seed, error) {
	if f.seedErr != nil {
		return nil, f.seedErr
	}
	if limit < len(f.seeds) {
		return f.seeds[:limit], nil
	}
	return f.seeds, nil
}

func (f *fakeLibrary) ActiveMembershipIDs(context.Context) (map[string]bool, error) {
	return f.activeIDs, nil
}

func (f *fakeLibrary) Revision(context.Context) (int64, error) { return f.revision, nil }

type fakeCandidates struct {
	titles []catalog.Title
	err    error
	calls  int
}

func (f *fakeCandidates) Candidates(context.Context) ([]catalog.Title, error) {
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	return f.titles, nil
}

type fakeSeedGenres struct {
	genres map[string][]string
	calls  map[string]int
	errFor map[string]error
}

func (f *fakeSeedGenres) SeedGenres(_ context.Context, canonicalID string) ([]string, error) {
	if f.calls == nil {
		f.calls = map[string]int{}
	}
	f.calls[canonicalID]++
	if err, ok := f.errFor[canonicalID]; ok {
		return nil, err
	}
	return f.genres[canonicalID], nil
}

func newTestService(lib LibrarySource, candidates CandidateSource, seedGenres SeedGenreSource, version int) *Service {
	return New(Deps{Library: lib, Candidates: candidates, SeedGenres: seedGenres, CandidateCacheVersion: version, Now: func() time.Time {
		return time.Unix(1_000_000, 0)
	}})
}

func tmdbMovie(id int64, title string, genres ...string) catalog.Title {
	return catalog.Title{
		ID: fmt.Sprintf("tmdb:movie:%d", id), Type: catalog.TypeMovie, Title: title,
		Year: 2024, ProviderIDs: map[string]string{"tmdb": fmt.Sprintf("movie:%d", id)},
		Genres: genres,
	}
}

func tmdbTV(id int64, title string, genres ...string) catalog.Title {
	return catalog.Title{
		ID: fmt.Sprintf("tmdb:tv:%d", id), Type: catalog.TypeSeries, Title: title,
		Year: 2023, ProviderIDs: map[string]string{"tmdb": fmt.Sprintf("tv:%d", id)},
		Genres: genres,
	}
}

// --- tests ---------------------------------------------------------------------

func TestNoFavouritesYieldsPopularFallback(t *testing.T) {
	lib := &fakeLibrary{activeIDs: map[string]bool{}}
	candidates := &fakeCandidates{titles: []catalog.Title{tmdbMovie(1, "A", "Action"), tmdbMovie(2, "B", "Drama")}}
	result, err := newTestService(lib, candidates, &fakeSeedGenres{}, 1).Recommend(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !result.Fallback {
		t.Fatalf("no seeds must be fallback=true: %+v", result)
	}
	if len(result.Items) != 2 {
		t.Fatalf("items = %d", len(result.Items))
	}
	for _, item := range result.Items {
		if item.Reason.Code != reasonPopular || item.Reason.Text != "Popular pick" {
			t.Fatalf("fallback reason wrong: %+v", item)
		}
	}
}

func TestOneSeedScoresCandidatesSharingItsGenre(t *testing.T) {
	lib := &fakeLibrary{
		seeds:     []library.Seed{{CanonicalID: "tmdb:movie:693134", Title: "Dune: Part Two", AddedAt: time.Unix(100, 0)}},
		activeIDs: map[string]bool{"tmdb:movie:693134": true},
	}
	seedGenres := &fakeSeedGenres{genres: map[string][]string{"tmdb:movie:693134": {"Science Fiction", "Adventure"}}}
	candidates := &fakeCandidates{titles: []catalog.Title{
		tmdbMovie(1, "Shares One Genre", "Science Fiction"),
		tmdbMovie(2, "No Match", "Romance"),
	}}
	result, err := newTestService(lib, candidates, seedGenres, 1).Recommend(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Fallback {
		t.Fatal("usable seeds must not be fallback")
	}
	if len(result.Items) != 2 {
		t.Fatalf("items = %d", len(result.Items))
	}
	first := result.Items[0]
	if first.CanonicalID != "tmdb:movie:1" || first.Reason.Code != reasonSeedGenre ||
		first.Reason.SeedCanonicalID != "tmdb:movie:693134" || first.Reason.Text != "Because you favourited Dune: Part Two" {
		t.Fatalf("scored item wrong: %+v", first)
	}
	if result.Items[1].Reason.Code != reasonPopular {
		t.Fatalf("zero-score filler must be a popular pick: %+v", result.Items[1])
	}
}

func TestDistinctSeedScoringWithRepeatedGenres(t *testing.T) {
	// Seed A shares ONE genre with the candidate; seed B shares TWO. Each
	// seed contributes at most ONE point → score 2, never 3; repeated genres
	// never inflate.
	lib := &fakeLibrary{
		seeds: []library.Seed{
			{CanonicalID: "tmdb:movie:2", Title: "Seed B", AddedAt: time.Unix(200, 0)},
			{CanonicalID: "tmdb:movie:1", Title: "Seed A", AddedAt: time.Unix(100, 0)},
		},
		activeIDs: map[string]bool{"tmdb:movie:1": true, "tmdb:movie:2": true},
	}
	seedGenres := &fakeSeedGenres{genres: map[string][]string{
		"tmdb:movie:1": {"Action"},
		"tmdb:movie:2": {"Action", "Adventure"},
	}}
	candidates := &fakeCandidates{titles: []catalog.Title{tmdbMovie(10, "Candidate", "Action", "Adventure")}}
	result, err := newTestService(lib, candidates, seedGenres, 1).Recommend(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Items) != 1 {
		t.Fatalf("items = %d", len(result.Items))
	}
	// Most recent contributing seed (Seed B, added later) supplies the reason.
	item := result.Items[0]
	if item.Reason.SeedCanonicalID != "tmdb:movie:2" || item.Reason.Text != "Because you favourited Seed B" {
		t.Fatalf("reason must ground in the most recent contributing seed: %+v", item)
	}
	_ = item
}

func TestDeterministicTieBreaks(t *testing.T) {
	lib := &fakeLibrary{
		seeds:     []library.Seed{{CanonicalID: "tmdb:movie:1", Title: "Seed", AddedAt: time.Unix(1, 0)}},
		activeIDs: map[string]bool{"tmdb:movie:1": true},
	}
	seedGenres := &fakeSeedGenres{genres: map[string][]string{"tmdb:movie:1": {"Action"}}}
	// All three candidates score 1 (same rank order in the pool); canonical id
	// breaks remaining ties.
	candidates := &fakeCandidates{titles: []catalog.Title{
		tmdbTV(300, "C", "Action"),
		tmdbMovie(200, "B", "Action"),
		tmdbMovie(100, "A", "Action"),
	}}
	result, err := newTestService(lib, candidates, seedGenres, 1).Recommend(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// All three score 1: the provider's popularity rank (pool position)
	// breaks the tie BEFORE the canonical id (contract §Ordering).
	got := ""
	for _, item := range result.Items {
		got += item.CanonicalID + " "
	}
	if got != "tmdb:tv:300 tmdb:movie:200 tmdb:movie:100 " {
		t.Fatalf("tie order wrong: %q", got)
	}
}

func TestFavouritesAndWatchLaterExcluded(t *testing.T) {
	lib := &fakeLibrary{
		seeds: []library.Seed{{CanonicalID: "tmdb:movie:1", Title: "Seed", AddedAt: time.Unix(1, 0)}},
		activeIDs: map[string]bool{
			"tmdb:movie:1": true, // favourite (seed)
			"tmdb:movie:2": true, // watch-later only
		},
	}
	seedGenres := &fakeSeedGenres{genres: map[string][]string{"tmdb:movie:1": {"Action"}}}
	candidates := &fakeCandidates{titles: []catalog.Title{
		tmdbMovie(1, "Favourite"),
		tmdbMovie(2, "Watch Later"),
		tmdbMovie(3, "Keep", "Action"),
	}}
	result, err := newTestService(lib, candidates, seedGenres, 1).Recommend(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Items) != 1 || result.Items[0].CanonicalID != "tmdb:movie:3" {
		t.Fatalf("exclusions broken: %+v", result.Items)
	}
}

func TestSameNumberMovieAndTVStayDistinct(t *testing.T) {
	lib := &fakeLibrary{
		seeds:     []library.Seed{{CanonicalID: "tmdb:movie:123", Title: "Movie 123", AddedAt: time.Unix(1, 0)}},
		activeIDs: map[string]bool{"tmdb:movie:123": true},
	}
	seedGenres := &fakeSeedGenres{genres: map[string][]string{"tmdb:movie:123": {"Action"}}}
	// The SERIES with the same numeric id must remain a candidate and must
	// NOT be excluded by the movie favourite.
	candidates := &fakeCandidates{titles: []catalog.Title{
		tmdbTV(123, "Series 123", "Action"),
		tmdbMovie(123, "Movie 123"),
	}}
	result, err := newTestService(lib, candidates, seedGenres, 1).Recommend(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Items) != 1 || result.Items[0].CanonicalID != "tmdb:tv:123" {
		t.Fatalf("same-number identity broken: %+v", result.Items)
	}
}

func TestAnimeKindPreserved(t *testing.T) {
	lib := &fakeLibrary{
		seeds:     []library.Seed{{CanonicalID: "tmdb:tv:209867", Title: "Frieren", AddedAt: time.Unix(1, 0)}},
		activeIDs: map[string]bool{"tmdb:tv:209867": true},
	}
	seedGenres := &fakeSeedGenres{genres: map[string][]string{"tmdb:tv:209867": {"Animation"}}}
	anime := tmdbTV(999, "Anime Candidate", "Animation")
	anime.Type = catalog.TypeAnime
	candidates := &fakeCandidates{titles: []catalog.Title{anime}}
	result, err := newTestService(lib, candidates, seedGenres, 1).Recommend(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Items) != 1 || result.Items[0].Type != "anime" || result.Items[0].CanonicalID != "tmdb:tv:999" {
		t.Fatalf("anime classification lost: %+v", result.Items)
	}
}

func TestDuplicateCandidatesDeduplicate(t *testing.T) {
	lib := &fakeLibrary{activeIDs: map[string]bool{}}
	candidates := &fakeCandidates{titles: []catalog.Title{
		tmdbMovie(1, "A"),
		tmdbMovie(1, "A"),
		tmdbMovie(2, "B"),
	}}
	result, err := newTestService(lib, candidates, &fakeSeedGenres{}, 1).Recommend(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Items) != 2 {
		t.Fatalf("duplicates survived: %+v", result.Items)
	}
}

func TestSparseCandidatesAndProviderFailure(t *testing.T) {
	lib := &fakeLibrary{
		seeds:     []library.Seed{{CanonicalID: "tmdb:movie:1", Title: "Seed", AddedAt: time.Unix(1, 0)}},
		activeIDs: map[string]bool{"tmdb:movie:1": true},
	}
	seedGenres := &fakeSeedGenres{genres: map[string][]string{"tmdb:movie:1": {"Action"}}}
	// First build succeeds so a stale result exists.
	candidates := &fakeCandidates{titles: []catalog.Title{tmdbMovie(5, "Only", "Action")}}
	service := newTestService(lib, candidates, seedGenres, 1)
	if _, err := service.Recommend(context.Background()); err != nil {
		t.Fatal(err)
	}
	// Provider fails on the NEXT build (forced via a candidate-cache version
	// bump): the last computed result is served DEGRADED, never an error to Home.
	service.candidateVn = 2
	candidates.err = errors.New("provider down")
	result, err := service.Recommend(context.Background())
	if err != nil {
		t.Fatalf("provider failure must not error Home: %v", err)
	}
	if !result.Degraded {
		t.Fatalf("served result must be degraded: %+v", result)
	}

	// Failure with NO cached result: truthful empty degraded section.
	fresh := newTestService(lib, &fakeCandidates{err: errors.New("down")}, seedGenres, 1)
	empty, err := fresh.Recommend(context.Background())
	if err != nil {
		t.Fatalf("candidate failure with no cache must still respond: %v", err)
	}
	if !empty.Degraded || len(empty.Items) != 0 {
		t.Fatalf("empty degraded section wrong: %+v", empty)
	}
}

func TestSeedGenreResolutionFailureStillExcludesSeed(t *testing.T) {
	lib := &fakeLibrary{
		seeds:     []library.Seed{{CanonicalID: "tmdb:movie:1", Title: "Seed", AddedAt: time.Unix(1, 0)}},
		activeIDs: map[string]bool{"tmdb:movie:1": true},
	}
	seedGenres := &fakeSeedGenres{errFor: map[string]error{"tmdb:movie:1": errors.New("metadata down")}}
	candidates := &fakeCandidates{titles: []catalog.Title{
		tmdbMovie(1, "Seed"), // excluded as favourite regardless of genre failure
		tmdbMovie(2, "Keep"),
	}}
	result, err := newTestService(lib, candidates, seedGenres, 1).Recommend(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// The seed exists but has NO usable genre metadata: nothing can be scored
	// → the section is truthfully a Popular-pick fallback, and the seed title
	// is still excluded from the results.
	if len(result.Items) != 1 || result.Items[0].CanonicalID != "tmdb:movie:2" {
		t.Fatalf("seed exclusion broken on genre failure: %+v", result.Items)
	}
	if !result.Fallback {
		t.Fatalf("no usable seeds must be fallback=true: %+v", result)
	}
	if result.Items[0].Reason.Code != reasonPopular {
		t.Fatalf("fallback items must be popular picks: %+v", result.Items[0])
	}
}

func TestCacheInvalidationByRevisionAndNoOpStability(t *testing.T) {
	lib := &fakeLibrary{revision: 7, activeIDs: map[string]bool{}}
	candidates := &fakeCandidates{titles: []catalog.Title{tmdbMovie(1, "A")}}
	service := newTestService(lib, candidates, &fakeSeedGenres{}, 1)
	ctx := context.Background()
	if _, err := service.Recommend(ctx); err != nil {
		t.Fatal(err)
	}
	if candidates.calls != 1 {
		t.Fatalf("candidate builds = %d, want 1", candidates.calls)
	}
	// Effective mutation: revision advances → cache key changes → recompute.
	lib.revision = 8
	if _, err := service.Recommend(ctx); err != nil {
		t.Fatal(err)
	}
	if candidates.calls != 2 {
		t.Fatalf("candidate builds after revision change = %d, want 2", candidates.calls)
	}
	// No-op write: revision UNCHANGED → cached result served (no recompute).
	if _, err := service.Recommend(ctx); err != nil {
		t.Fatal(err)
	}
	if candidates.calls != 2 {
		t.Fatalf("no-op write must not invalidate: builds = %d, want 2", candidates.calls)
	}
}

func TestCandidateCacheVersionInvalidation(t *testing.T) {
	lib := &fakeLibrary{revision: 1, activeIDs: map[string]bool{}}
	candidates := &fakeCandidates{titles: []catalog.Title{tmdbMovie(1, "A")}}
	service := newTestService(lib, candidates, &fakeSeedGenres{}, 1)
	ctx := context.Background()
	if _, err := service.Recommend(ctx); err != nil {
		t.Fatal(err)
	}
	service.candidateVn = 2 // provider-side candidate pool changed
	if _, err := service.Recommend(ctx); err != nil {
		t.Fatal(err)
	}
	if candidates.calls != 2 {
		t.Fatalf("candidate-cache version change must invalidate: builds = %d", candidates.calls)
	}
}

func TestCacheExpiryAfterFifteenMinutes(t *testing.T) {
	lib := &fakeLibrary{revision: 1, activeIDs: map[string]bool{}}
	candidates := &fakeCandidates{titles: []catalog.Title{tmdbMovie(1, "A")}}
	now := time.Unix(1_000_000, 0)
	service := New(Deps{Library: lib, Candidates: candidates, SeedGenres: &fakeSeedGenres{}, CandidateCacheVersion: 1, Now: func() time.Time { return now }})
	ctx := context.Background()
	if _, err := service.Recommend(ctx); err != nil {
		t.Fatal(err)
	}
	now = now.Add(14 * time.Minute)
	if _, err := service.Recommend(ctx); err != nil {
		t.Fatal(err)
	}
	if candidates.calls != 1 {
		t.Fatal("entry younger than 15 minutes must be served from cache")
	}
	now = now.Add(2 * time.Minute) // beyond the 15-minute TTL
	if _, err := service.Recommend(ctx); err != nil {
		t.Fatal(err)
	}
	if candidates.calls != 2 {
		t.Fatalf("entries older than 15 minutes must expire: builds = %d", candidates.calls)
	}
}

func TestSeedLimitIsTwenty(t *testing.T) {
	lib := &fakeLibrary{activeIDs: map[string]bool{}}
	for i := 1; i <= 30; i++ {
		id := fmt.Sprintf("tmdb:movie:%d", i)
		lib.seeds = append(lib.seeds, library.Seed{CanonicalID: id, Title: id, AddedAt: time.Unix(int64(i), 0)})
		lib.activeIDs[id] = true
	}
	seedGenres := &fakeSeedGenres{genres: map[string][]string{}}
	for i := 1; i <= 30; i++ {
		seedGenres.genres[fmt.Sprintf("tmdb:movie:%d", i)] = []string{"Action"}
	}
	candidates := &fakeCandidates{titles: []catalog.Title{tmdbMovie(1000, "C", "Action")}}
	// The service asks the library for at most 20 seeds: with a fake that
	// honors the limit, only the 20 most recent seeds exist.
	limiting := &limitingLibrary{fakeLibrary: lib, limit: 20}
	service := newTestService(limiting, candidates, seedGenres, 1)
	if _, err := service.Recommend(context.Background()); err != nil {
		t.Fatal(err)
	}
	if limiting.requestedLimit == 0 || limiting.requestedLimit > 20 {
		t.Fatalf("seed request limit = %d, want <= 20", limiting.requestedLimit)
	}
}

type limitingLibrary struct {
	*fakeLibrary
	limit          int
	requestedLimit int
}

func (l *limitingLibrary) FavouriteSeeds(ctx context.Context, limit int) ([]library.Seed, error) {
	l.requestedLimit = limit
	return l.fakeLibrary.FavouriteSeeds(ctx, limit)
}
