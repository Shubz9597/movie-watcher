package recommendations

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"torrent-streamer/internal/catalog"
	"torrent-streamer/internal/profiles"
)

type mutableTaste struct {
	mu      sync.Mutex
	signals []TasteSignal
}

func (m *mutableTaste) HouseholdSignals(context.Context) ([]TasteSignal, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]TasteSignal(nil), m.signals...), nil
}

func (m *mutableTaste) set(signals ...TasteSignal) {
	m.mu.Lock()
	m.signals = signals
	m.mu.Unlock()
}

func reasonsOf(result Result) map[string]string {
	out := map[string]string{}
	for _, item := range result.Items {
		out[item.CanonicalID] = item.Reason.Text
	}
	return out
}

// Starting a show changes the recommendations within minutes, not when the
// 15-minute cache runs out: the next load gets the old list at once and a
// recompute, the one after gets the new list.
func TestStartingAShowRefreshesRecommendations(t *testing.T) {
	now := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	taste := &mutableTaste{}
	taste.set(TasteSignal{CanonicalID: "tmdb:tv:1438", Label: "watched", Weight: 4, Title: "The Wire", At: now.Add(-24 * time.Hour)})
	svc := New(Deps{
		Library:    &fakeLibrary{revision: 1},
		Candidates: &fakeCandidates{},
		SeedGenres: &fakeSeedGenres{genres: map[string][]string{"tmdb:tv:1438": {"Crime"}, "tmdb:tv:1399": {"Fantasy"}}},
		SeedSimilar: fakeSimilar{
			"tmdb:tv:1438": {title("tmdb:tv:wire-like", "Crime")},
			"tmdb:tv:1399": {title("tmdb:tv:got-like", "Fantasy")},
		},
		Taste: taste,
		Now:   func() time.Time { return now },
	})
	ctx := profiles.WithProfile(context.Background(), profiles.Profile{ID: "household"})
	first, err := svc.Recommend(ctx)
	if err != nil || reasonsOf(first)["tmdb:tv:got-like"] != "" {
		t.Fatalf("before: %v %+v", err, first.Items)
	}

	// Positions moving within the same titles change nothing.
	same, _ := svc.Recommend(ctx)
	if !same.GeneratedAt.Equal(first.GeneratedAt) {
		t.Fatal("an unchanged taste must keep the cached result")
	}

	taste.set(
		TasteSignal{CanonicalID: "tmdb:tv:1438", Label: "watched", Weight: 4, Title: "The Wire", At: now.Add(-24 * time.Hour)},
		TasteSignal{CanonicalID: "tmdb:tv:1399", Label: "completed"},
		TasteSignal{CanonicalID: "tmdb:tv:1399", Label: "started", Weight: 2, Title: "Game of Thrones", At: now.Add(-time.Hour)},
	)
	svc.Recommend(ctx) // serves the old list, recomputes in the background
	svc.refreshWG.Wait()
	after, _ := svc.Recommend(ctx)
	if got := reasonsOf(after)["tmdb:tv:got-like"]; got != "Because you started Game of Thrones" {
		t.Fatalf("after starting Game of Thrones: %q (%+v)", got, after.Items)
	}
}

// The refresh loop recomputes a profile whose taste changed, so the next
// Home load already has it.
func TestRefreshLoopRecomputesChangedTaste(t *testing.T) {
	now := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	taste := &mutableTaste{}
	taste.set(TasteSignal{CanonicalID: "tmdb:tv:1438", Label: "watched", Weight: 4, Title: "The Wire", At: now})
	svc := New(Deps{
		Library:     &fakeLibrary{revision: 1},
		Candidates:  &fakeCandidates{},
		SeedGenres:  &fakeSeedGenres{genres: map[string][]string{}},
		SeedSimilar: fakeSimilar{"tmdb:tv:1399": {title("tmdb:tv:got-like")}},
		Taste:       taste,
		Now:         func() time.Time { return now },
	})
	profile := profiles.Profile{ID: "household"}
	ctx := profiles.WithProfile(context.Background(), profile)
	if _, err := svc.Recommend(ctx); err != nil {
		t.Fatal(err)
	}
	taste.set(TasteSignal{CanonicalID: "tmdb:tv:1399", Label: "started", Weight: 2, Title: "Game of Thrones", At: now})
	loopCtx, stop := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		svc.RefreshLoop(loopCtx, func(context.Context) []profiles.Profile { return []profiles.Profile{profile} }, 5*time.Millisecond)
		close(done)
	}()
	deadline := time.Now().Add(2 * time.Second)
	for {
		svc.mu.Lock()
		cached := svc.cache["household"]
		svc.mu.Unlock()
		if cached != nil && cached.taste == svc.tasteFingerprint(ctx) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the refresh loop did not recompute the changed taste")
		}
		time.Sleep(5 * time.Millisecond)
	}
	stop()
	<-done
	svc.refreshWG.Wait()
	result, _ := svc.Recommend(ctx)
	if reasonsOf(result)["tmdb:tv:got-like"] == "" {
		t.Fatalf("next load must already show it: %+v", result.Items)
	}
}

// Two shows "sharing genres" with the same popular film of the other media
// type is no consensus (consensus picks lead the row): the film credits one
// show and takes its turn among that show's picks.
func TestCrossoverListsNeverMakeConsensus(t *testing.T) {
	now := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	lionKing := title("tmdb:movie:8587", "Animation", "Family")
	svc := New(Deps{
		Library:    &fakeLibrary{revision: 1},
		Candidates: &fakeCandidates{},
		SeedGenres: &fakeSeedGenres{genres: map[string][]string{}},
		SeedSimilar: fakeSimilar{
			"tmdb:tv:67075": {title("tmdb:tv:mob-like")},
			"tmdb:tv:13916": {title("tmdb:tv:death-like")},
		},
		CrossSimilar: fakeSimilar{
			"tmdb:tv:67075": {lionKing},
			"tmdb:tv:13916": {lionKing},
		},
		Taste: fakeTaste{signals: []TasteSignal{
			{CanonicalID: "tmdb:tv:67075", Label: "watched", Weight: 6, Title: "Mob Psycho 100", At: now},
			{CanonicalID: "tmdb:tv:13916", Label: "watched", Weight: 5, Title: "Death Note", At: now},
		}},
		Now: func() time.Time { return now },
	})
	result, err := svc.Recommend(context.Background())
	if err != nil || len(result.Items) == 0 {
		t.Fatalf("recommend: %v", err)
	}
	reason := reasonsOf(result)["tmdb:movie:8587"]
	if strings.Contains(reason, " and ") || reason != "Because you watched Mob Psycho 100" {
		t.Fatalf("crossover reason = %q", reason)
	}
}

// What is being watched now gets its own "more like this", even when older
// finished shows weigh more.
func TestRecentShowsAlwaysSeedRecommendations(t *testing.T) {
	now := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	signals := []TasteSignal{}
	similar := fakeSimilar{}
	for i, name := range []string{"a", "b", "c", "d", "e", "f", "g"} {
		id := "tmdb:tv:old-" + name
		signals = append(signals, TasteSignal{CanonicalID: id, Label: "watched", Weight: 6, Title: "Old " + name, At: now.Add(-time.Duration(20+i) * 24 * time.Hour)})
		similar[id] = []catalog.Title{title(id + "-like")}
	}
	signals = append(signals, TasteSignal{CanonicalID: "tmdb:tv:1399", Label: "started", Weight: 2, Title: "Game of Thrones", At: now.Add(-2 * time.Hour)})
	similar["tmdb:tv:1399"] = []catalog.Title{title("tmdb:tv:got-like")}
	svc := New(Deps{
		Library:     &fakeLibrary{revision: 1},
		Candidates:  &fakeCandidates{},
		SeedGenres:  &fakeSeedGenres{genres: map[string][]string{}},
		SeedSimilar: similar,
		Taste:       fakeTaste{signals: signals},
		Now:         func() time.Time { return now },
	})
	result, err := svc.Recommend(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got := reasonsOf(result)["tmdb:tv:got-like"]; got != "Because you started Game of Thrones" {
		t.Fatalf("the show started today must seed picks: %q (%+v)", got, result.Items)
	}
}

func TestSeedOrderPromotesRecentTitles(t *testing.T) {
	now := time.Date(2026, 11, 10, 0, 0, 0, 0, time.UTC)
	type seed struct {
		id     string
		weight float64
		at     time.Time
	}
	var seeds []seed
	for i := 0; i < 8; i++ {
		seeds = append(seeds, seed{id: string(rune('a' + i)), weight: float64(10 - i), at: now.Add(-60 * 24 * time.Hour)})
	}
	seeds = append(seeds, seed{id: "new1", weight: 1, at: now.Add(-time.Hour)}, seed{id: "new2", weight: 0.5, at: now.Add(-2 * time.Hour)}, seed{id: "new3", weight: 0.4, at: now.Add(-3 * time.Hour)})
	ordered := seedOrder(seeds, func(s seed) (float64, time.Time) { return s.weight, s.at }, now)
	var head []string
	for _, s := range ordered[:seedSimilarSeeds] {
		head = append(head, s.id)
	}
	if strings.Join(head, ",") != "a,b,c,d,new1,new2" {
		t.Fatalf("first seeds = %v", head)
	}
	if len(ordered) != len(seeds) || ordered[seedSimilarSeeds].id != "e" {
		t.Fatalf("the bumped seeds follow: %v", ordered)
	}
}
