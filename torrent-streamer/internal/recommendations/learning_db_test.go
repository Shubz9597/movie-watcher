package recommendations

import (
	"context"
	"testing"
	"time"

	"torrent-streamer/internal/profiles"
)

// Against Postgres: seen cards count views (one per 6 hours), outcomes come
// from the profile's own activity after the card was first shown, "not
// interested" leaves the row at once, a model is stored and read back.
func TestFeedbackRecordsOutcomesAndNotInterested(t *testing.T) {
	db, _ := testLibraryDB(t)
	ctx := context.Background()
	feedback := &Feedback{DB: db}
	features := Features{"prior": 2, "seed": 2}

	for _, id := range []string{"tmdb:tv:started", "tmdb:tv:ignored", "tmdb:tv:opened", "tmdb:tv:rejected"} {
		if err := feedback.Seen(ctx, "household", []string{id}, []int{3}, []Features{features}); err != nil {
			t.Fatal(err)
		}
	}
	// The same card again within 6 hours is the same view; later, a new one.
	_ = feedback.Seen(ctx, "household", []string{"tmdb:tv:ignored"}, []int{1}, []Features{features})
	var views, position int
	_ = db.QueryRowContext(ctx, `SELECT views, best_position FROM rec_impressions WHERE canonical_id='tmdb:tv:ignored'`).Scan(&views, &position)
	if views != 1 || position != 1 {
		t.Fatalf("views=%d position=%d, want 1 and 1", views, position)
	}
	for i := 0; i < 3; i++ {
		_, _ = db.ExecContext(ctx, `UPDATE rec_impressions SET last_shown_at = now() - interval '7 hours' WHERE canonical_id='tmdb:tv:ignored'`)
		_ = feedback.Seen(ctx, "household", []string{"tmdb:tv:ignored"}, []int{2}, []Features{features})
	}
	_ = db.QueryRowContext(ctx, `SELECT views FROM rec_impressions WHERE canonical_id='tmdb:tv:ignored'`).Scan(&views)
	if views != 4 {
		t.Fatalf("views = %d, want 4", views)
	}

	// What the profile did afterwards.
	if _, err := db.ExecContext(ctx, `
INSERT INTO watch_progress (subject_id, series_id, season, episode, position_s, duration_s, percent)
VALUES ('household', 'tmdb:tv:started', 1, 1, 600, 3000, 20);
INSERT INTO taste_events (subject_id, canonical_id, kind) VALUES ('household', 'tmdb:tv:opened', 'series')`); err != nil {
		t.Fatal(err)
	}
	if err := feedback.SetNotInterested(ctx, "household", "tmdb:tv:rejected", "Rejected Show", false); err != nil {
		t.Fatal(err)
	}

	samples, err := feedback.Samples(ctx, "household", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]float64{}
	for _, sample := range samples {
		got[sample.ID] = sample.Label
		if sample.Features["seed"] != 2 {
			t.Fatalf("features not kept: %+v", sample)
		}
	}
	want := map[string]float64{"tmdb:tv:started": 1, "tmdb:tv:opened": 1, "tmdb:tv:ignored": 0, "tmdb:tv:rejected": 0}
	if len(got) != len(want) {
		t.Fatalf("samples = %v", got)
	}
	for id, label := range want {
		if got[id] != label {
			t.Errorf("%s label = %v, want %v", id, got[id], label)
		}
	}

	stats, err := feedback.Stats(ctx, "household", 30, time.Now())
	if err != nil || stats.Shown != 4 || stats.Started != 1 || stats.Opened != 1 || stats.NotInterested != 1 {
		t.Fatalf("stats = %+v, %v", stats, err)
	}

	model := &Model{Weights: map[string]float64{"prior": 0.8, "sim": 0.4}, Samples: 40, Positives: 12, TrainedAt: time.Now().Truncate(time.Second)}
	if err := feedback.SaveModel(ctx, "household", model); err != nil {
		t.Fatal(err)
	}
	loaded, err := feedback.LoadModel(ctx, "household")
	if err != nil || loaded == nil || loaded.Weights["sim"] != 0.4 || loaded.Samples != 40 {
		t.Fatalf("model = %+v, %v", loaded, err)
	}

	// Not interested: gone from the row at once, and from later results.
	taste := &mutableTaste{}
	taste.set(TasteSignal{CanonicalID: "tmdb:tv:seed", Label: "watched", Weight: 4, Title: "Seed Show", At: time.Now()})
	svc := New(Deps{
		Library:     &fakeLibrary{revision: 1},
		Candidates:  &fakeCandidates{},
		SeedGenres:  &fakeSeedGenres{genres: map[string][]string{"tmdb:tv:seed": {"Drama"}}},
		SeedSimilar: fakeSimilar{"tmdb:tv:seed": {title("tmdb:tv:a", "Drama"), title("tmdb:tv:b", "Drama")}},
		Taste:       taste,
		Feedback:    feedback,
	})
	profileCtx := profiles.WithProfile(ctx, profiles.Profile{ID: "household", HouseholdID: 1})
	first, err := svc.Recommend(profileCtx)
	if err != nil || len(first.Items) != 2 {
		t.Fatalf("first = %+v, %v", first.Items, err)
	}
	if err := svc.NotInterested(profileCtx, "tmdb:tv:a", "A", false); err != nil {
		t.Fatal(err)
	}
	cached, _ := svc.Recommend(profileCtx)
	svc.refreshWG.Wait()
	later, _ := svc.Recommend(profileCtx)
	for _, result := range []Result{cached, later} {
		for _, item := range result.Items {
			if item.CanonicalID == "tmdb:tv:a" {
				t.Fatalf("not-interested title still recommended: %+v", result.Items)
			}
		}
	}
	// Undo brings it back.
	if err := svc.NotInterested(profileCtx, "tmdb:tv:a", "A", true); err != nil {
		t.Fatal(err)
	}
	svc.Recommend(profileCtx)
	svc.refreshWG.Wait()
	back, _ := svc.Recommend(profileCtx)
	if reasonsOf(back)["tmdb:tv:a"] == "" {
		t.Fatalf("undo: %+v", back.Items)
	}

	// Cards seen record the features they were ranked by.
	if err := svc.Seen(profileCtx, []string{"tmdb:tv:b"}, []int{0}); err != nil {
		t.Fatal(err)
	}
	var raw string
	_ = db.QueryRowContext(ctx, `SELECT COALESCE(features::text, '') FROM rec_impressions WHERE canonical_id='tmdb:tv:b'`).Scan(&raw)
	if raw == "" {
		t.Fatal("seen card stored without its features")
	}
}
