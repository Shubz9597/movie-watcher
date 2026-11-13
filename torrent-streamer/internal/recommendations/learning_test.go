package recommendations

import (
	"context"
	"strings"
	"testing"
	"time"

	"torrent-streamer/internal/catalog"
	"torrent-streamer/internal/embeddings"
	"torrent-streamer/internal/profiles"
)

// Too few outcomes: no model, the prior ranks.
func TestTrainKeepsThePriorWithFewOutcomes(t *testing.T) {
	samples := []Sample{
		{Features: Features{"prior": 3}, Label: 1, Weight: 1},
		{Features: Features{"prior": 1}, Label: 0, Weight: 1},
	}
	if model := Train(samples, time.Now()); model != nil {
		t.Fatalf("model from 2 outcomes: %+v", model)
	}
	var model *Model
	if got := model.Score(Features{"prior": 2.5}); got != 2.5 {
		t.Fatalf("untrained score = %v, want the prior", got)
	}
}

// What the profile actually watches wins over the hand-set prior: here the
// prior favours titles many lists agree on, but the profile starts the ones
// that resemble its shows and ignores the rest. The model learns that.
func TestTrainLearnsWhatTheProfileWatches(t *testing.T) {
	var samples []Sample
	for i := 0; i < 30; i++ {
		jitter := float64(i%5) * 0.1
		liked := Features{"seed": 0.5 + jitter, "seedTop": 0.5 + jitter, "sim": 1.0 + jitter}
		liked["prior"] = priorScore(liked)
		ignored := Features{"seed": 8 + jitter, "seedTop": 8 + jitter, "sim": -0.5 + jitter}
		ignored["prior"] = priorScore(ignored)
		samples = append(samples,
			Sample{ID: "liked", Features: liked, Label: 1, Weight: 1},
			Sample{ID: "ignored", Features: ignored, Label: 0, Weight: 1})
	}
	likedProbe := Features{"seed": 0.6, "seedTop": 0.6, "sim": 1.1}
	likedProbe["prior"] = priorScore(likedProbe)
	ignoredProbe := Features{"seed": 8.1, "seedTop": 8.1, "sim": -0.4}
	ignoredProbe["prior"] = priorScore(ignoredProbe)
	if (*Model)(nil).Score(likedProbe) >= (*Model)(nil).Score(ignoredProbe) {
		t.Fatal("setup: the prior should prefer the ignored kind")
	}
	model := Train(samples, time.Now())
	if model == nil {
		t.Fatal("no model from 60 outcomes")
	}
	if model.Score(likedProbe) <= model.Score(ignoredProbe) {
		t.Fatalf("model still prefers the ignored kind: weights %+v", model.Weights)
	}
	if model.AUC < 0.9 || model.Samples != 60 || model.Positives != 30 {
		t.Fatalf("fit = %+v", model)
	}
}

func TestOutcomeLabels(t *testing.T) {
	now := time.Date(2026, 11, 13, 12, 0, 0, 0, time.UTC)
	f := Features{"prior": 1}
	cases := []struct {
		name   string
		o      outcome
		label  float64
		weight float64
		ok     bool
	}{
		{"rejected", outcome{rejected: true, views: 1, opened: true}, 0, 2, true},
		{"finished an episode", outcome{started: true, finished: 1, lastProgress: now}, 1, 1.5, true},
		{"started this week", outcome{started: true, best: 10, lastProgress: now.Add(-48 * time.Hour)}, 1, 1, true},
		{"dropped", outcome{started: true, best: 10, lastProgress: now.Add(-30 * 24 * time.Hour)}, 0, 0.5, true},
		{"saved", outcome{saved: true}, 1, 1, true},
		{"only opened", outcome{opened: true}, 1, 0.4, true},
		{"ignored 3 times", outcome{views: 3, lastAt: now}, 0, 1, true},
		{"seen twice, long ago", outcome{views: 2, lastAt: now.Add(-20 * 24 * time.Hour)}, 0, 0.5, true},
		{"seen once", outcome{views: 1, lastAt: now}, 0, 0, false},
	}
	for _, c := range cases {
		c.o.features = f
		sample, ok := label(c.o, now)
		if ok != c.ok || (ok && (sample.Label != c.label || sample.Weight != c.weight)) {
			t.Errorf("%s: got %+v ok=%v, want label %v weight %v ok=%v", c.name, sample, ok, c.label, c.weight, c.ok)
		}
	}
	// Without the features it was ranked by, an outcome can't train.
	if _, ok := label(outcome{rejected: true}, now); ok {
		t.Error("an outcome without features must not train")
	}
}

// fakeDetails answers SeedDetail (genres, name, plot) for the profile's titles.
type fakeDetails map[string]catalog.Title

func (f fakeDetails) SeedGenres(_ context.Context, id string) ([]string, error) {
	if title, ok := f[id]; ok {
		return title.Genres, nil
	}
	return nil, catalog.ErrNotFound
}

func (f fakeDetails) SeedDetail(_ context.Context, id string) (catalog.Title, error) {
	if title, ok := f[id]; ok {
		return title, nil
	}
	return catalog.Title{}, catalog.ErrNotFound
}

// fakeEmbedder gives fixed unit vectors per id.
type fakeEmbedder map[string][]float32

func (f fakeEmbedder) Vectors(_ context.Context, docs []embeddings.Doc) map[string][]float32 {
	out := map[string][]float32{}
	for _, doc := range docs {
		if vector, ok := f[doc.ID]; ok {
			out[doc.ID] = vector
		}
	}
	return out
}

func unit(values ...float32) []float32 {
	var sum float64
	for _, v := range values {
		sum += float64(v) * float64(v)
	}
	norm := float32(1 / sqrt(sum))
	out := make([]float32, len(values))
	for i, v := range values {
		out[i] = v * norm
	}
	return out
}

func sqrt(x float64) float64 {
	z := x
	for i := 0; i < 30; i++ {
		z -= (z*z - x) / (2 * z)
	}
	return z
}

func described(id, name, overview string, genres ...string) catalog.Title {
	return catalog.Title{ID: id, Title: name, Type: catalog.TypeSeries, Overview: overview, Genres: genres}
}

// Content understanding: a title no list mentions but that plainly resembles
// a watched show is recommended because of it; titles like a dropped show
// sink; the dropped show itself is not taste (its lists don't feed the row).
func TestContentSimilarityFindsUnlistedTitlesAndCountsDroppedAgainst(t *testing.T) {
	now := time.Date(2026, 11, 13, 12, 0, 0, 0, time.UTC)
	taste := &mutableTaste{}
	taste.set(
		TasteSignal{CanonicalID: "tmdb:tv:severance", Label: "completed"},
		TasteSignal{CanonicalID: "tmdb:tv:severance", Label: "watched", Weight: 4, Title: "tmdb:tv:severance", At: now.Add(-24 * time.Hour)},
		TasteSignal{CanonicalID: "tmdb:tv:soap", Label: "completed"},
		TasteSignal{CanonicalID: "tmdb:tv:soap", Label: "dropped", Title: "tmdb:tv:soap", At: now.Add(-40 * 24 * time.Hour)},
	)
	svc := New(Deps{
		Library: &fakeLibrary{revision: 1},
		Candidates: &fakeCandidates{titles: []catalog.Title{
			described("tmdb:tv:unrelated", "Cooking Show", "Chefs compete.", "Reality"),
			described("tmdb:tv:soap-twin", "Another Soap", "Families feud.", "Drama"),
			described("tmdb:tv:mystery-twin", "Office Puzzle", "Workers uncover a conspiracy.", "Mystery"),
		}},
		SeedGenres: fakeDetails{
			"tmdb:tv:severance": described("tmdb:tv:severance", "Severance", "Office workers' memories are split.", "Drama", "Mystery"),
			"tmdb:tv:soap":      described("tmdb:tv:soap", "The Soap", "Families feud.", "Drama"),
		},
		SeedSimilar: fakeSimilar{
			"tmdb:tv:soap": {described("tmdb:tv:soap-list", "Soap Pick", "More feuds.", "Drama")},
		},
		Embeddings: fakeEmbedder{
			"tmdb:tv:severance":    unit(1, 0, 0),
			"tmdb:tv:mystery-twin": unit(0.95, 0.05, 0),
			"tmdb:tv:soap":         unit(0, 1, 0),
			"tmdb:tv:soap-twin":    unit(0.1, 0.95, 0),
			"tmdb:tv:unrelated":    unit(0.3, 0.3, 0.9),
		},
		Taste: taste,
		Now:   func() time.Time { return now },
	})
	ctx := profiles.WithProfile(context.Background(), profiles.Profile{ID: "household"})
	result, err := svc.Recommend(ctx)
	if err != nil {
		t.Fatal(err)
	}
	order := map[string]int{}
	for i, item := range result.Items {
		order[item.CanonicalID] = i
	}
	reasons := reasonsOf(result)
	if got := reasons["tmdb:tv:mystery-twin"]; got != "Because you watched Severance" {
		t.Fatalf("content twin reason = %q (%+v)", got, result.Items)
	}
	if _, listed := order["tmdb:tv:soap-list"]; listed {
		t.Fatal("a dropped show's lists must not feed recommendations")
	}
	if order["tmdb:tv:mystery-twin"] > order["tmdb:tv:unrelated"] || order["tmdb:tv:soap-twin"] < order["tmdb:tv:unrelated"] {
		t.Fatalf("order = %v", order)
	}
	if f := result.features["tmdb:tv:soap-twin"]; f["neg"] <= 0 {
		t.Fatalf("soap twin features = %v, want a penalty for resembling the dropped show", f)
	}
	for _, item := range result.Items {
		if strings.Contains(item.Reason.Text, "Soap") {
			t.Fatalf("a dropped show is never a reason: %+v", item)
		}
	}
}
