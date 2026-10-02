package recommendations

import (
	"context"
	"strings"
	"testing"
	"time"

	"torrent-streamer/internal/catalog"
)

type fakeTaste struct{ signals []TasteSignal }

func (f fakeTaste) HouseholdSignals(context.Context) ([]TasteSignal, error) { return f.signals, nil }

type fakeSimilar map[string][]catalog.Title

func (f fakeSimilar) SeedSimilar(_ context.Context, id string, _ int) ([]catalog.Title, error) {
	return f[id], nil
}

func title(id string, genres ...string) catalog.Title {
	return catalog.Title{ID: id, Title: id, Genres: genres}
}

// A heavier signal (Watch Later) must not take over every reason: each
// recommendation credits the show whose "more like this" list produced it,
// the list rotates between shows, and downloaded anime yields anime picks.
func TestTasteRecommendationsCreditSourceAndRotate(t *testing.T) {
	svc := New(Deps{
		Library:    &fakeLibrary{revision: 1},
		Candidates: &fakeCandidates{},
		SeedGenres: &fakeSeedGenres{genres: map[string][]string{
			"tmdb:tv:1438":   {"Drama", "Crime"},
			"tmdb:tv:95396":  {"Drama", "Mystery"},
			"anilist:154587": {"Fantasy", "Adventure"},
		}},
		SeedSimilar: fakeSimilar{
			"tmdb:tv:1438":   {title("tmdb:tv:wire-a", "Drama", "Crime"), title("tmdb:tv:wire-b", "Drama")},
			"tmdb:tv:95396":  {title("tmdb:tv:sev-a", "Drama", "Mystery"), title("tmdb:tv:sev-b", "Mystery")},
			"anilist:154587": {title("anilist:fr-a", "Fantasy")},
		},
		Taste: fakeTaste{signals: []TasteSignal{
			{CanonicalID: "tmdb:tv:1438", Label: "watch-later", Weight: 3, Title: "The Wire"},
			{CanonicalID: "tmdb:tv:95396", Label: "completed", Weight: 0},
			{CanonicalID: "tmdb:tv:95396", Label: "started", Weight: 2, Title: "Severance"},
			{CanonicalID: "anilist:154587", Label: "completed", Weight: 0},
			{CanonicalID: "anilist:154587", Label: "downloaded", Weight: 3, Title: "Frieren"},
		}},
		Now: func() time.Time { return time.Unix(1_000_000, 0) },
	})
	result, err := svc.Recommend(context.Background())
	if err != nil {
		t.Fatalf("recommend: %v", err)
	}
	reasons := map[string]string{}
	var order []string
	for _, item := range result.Items {
		reasons[item.CanonicalID] = item.Reason.Text
		order = append(order, item.CanonicalID)
	}
	if !strings.Contains(reasons["tmdb:tv:sev-a"], "Severance") {
		t.Fatalf("Severance's similar title must credit Severance, got %q", reasons["tmdb:tv:sev-a"])
	}
	if reasons["anilist:fr-a"] != "Because you downloaded Frieren" {
		t.Fatalf("downloaded anime must produce an anime pick, got %q", reasons["anilist:fr-a"])
	}
	if len(order) < 3 {
		t.Fatalf("expected rotated picks, got %v", order)
	}
	firstThree := map[string]bool{}
	for _, id := range order[:3] {
		firstThree[strings.SplitN(reasons[id], " ", 4)[3]] = true
	}
	if len(firstThree) != 3 {
		t.Fatalf("the first picks must rotate between shows, got %v (%v)", order[:3], reasons)
	}
}

// A title several household titles point at is a consensus pick: it leads,
// and its reason names both titles. Crossover lists mix in the other media
// type for a seed.
func TestTasteConsensusLeadsAndCrossoverMixes(t *testing.T) {
	shared := title("tmdb:tv:shared", "Drama", "Mystery")
	svc := New(Deps{
		Library:    &fakeLibrary{revision: 1},
		Candidates: &fakeCandidates{},
		SeedGenres: &fakeSeedGenres{genres: map[string][]string{
			"tmdb:tv:1438":  {"Drama", "Crime"},
			"tmdb:tv:95396": {"Drama", "Mystery"},
		}},
		SeedSimilar: fakeSimilar{
			"tmdb:tv:1438":  {title("tmdb:tv:wire-a", "Crime"), shared},
			"tmdb:tv:95396": {title("tmdb:tv:sev-a", "Mystery"), shared},
		},
		CrossSimilar: fakeSimilar{
			"tmdb:tv:95396": {title("tmdb:movie:memento", "Mystery")},
		},
		Taste: fakeTaste{signals: []TasteSignal{
			{CanonicalID: "tmdb:tv:1438", Label: "watch-later", Weight: 3, Title: "The Wire"},
			{CanonicalID: "tmdb:tv:95396", Label: "watched", Weight: 4, Title: "Severance"},
		}},
		Now: func() time.Time { return time.Unix(1_000_000, 0) },
	})
	result, err := svc.Recommend(context.Background())
	if err != nil || len(result.Items) == 0 {
		t.Fatalf("recommend: %v items=%d", err, len(result.Items))
	}
	first := result.Items[0]
	if first.CanonicalID != "tmdb:tv:shared" || first.Reason.Text != "Because you like Severance and The Wire" {
		t.Fatalf("consensus pick must lead with a joint reason, got %s %q", first.CanonicalID, first.Reason.Text)
	}
	found := false
	for _, item := range result.Items {
		if item.CanonicalID == "tmdb:movie:memento" {
			found = item.Reason.Text == "Because you watched Severance"
		}
	}
	if !found {
		t.Fatalf("crossover movie must be recommended for the series: %+v", result.Items)
	}
}

func TestMixCrossInterleavesTwoToOne(t *testing.T) {
	same := []catalog.Title{title("a"), title("b"), title("c")}
	cross := []catalog.Title{title("x"), title("y")}
	var ids []string
	for _, item := range mixCross(same, cross) {
		ids = append(ids, item.ID)
	}
	if strings.Join(ids, ",") != "a,b,x,c,y" {
		t.Fatalf("mix = %v", ids)
	}
}
