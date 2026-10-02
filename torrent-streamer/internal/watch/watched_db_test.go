package watch

import (
	"context"
	"testing"
	"time"
)

func TestSetWatchedMarksQueuesNextAndUnmarks(t *testing.T) {
	store := newCharacterizationStore(t)
	ctx := context.Background()
	subject, series := t.Name(), "tmdb:tv:1"

	if err := store.SetWatched(ctx, subject, series, []EpisodeRef{{1, 1}, {1, 2}}, true, &EpisodeRef{1, 3}); err != nil {
		t.Fatalf("mark watched: %v", err)
	}
	items, err := store.ListWatched(ctx, subject, series)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	watched := map[int]bool{}
	for _, item := range items {
		watched[item.Episode] = item.Watched
	}
	if !watched[1] || !watched[2] {
		t.Fatalf("episodes 1-2 must be watched: %+v", items)
	}
	continueList, err := store.ListContinue(ctx, subject, 10)
	if err != nil || len(continueList) != 1 || continueList[0].Episode != 3 {
		t.Fatalf("continue must point at episode 3: %+v err=%v", continueList, err)
	}

	if err := store.SetWatched(ctx, subject, series, []EpisodeRef{{1, 2}}, false, nil); err != nil {
		t.Fatalf("unmark: %v", err)
	}
	items, _ = store.ListWatched(ctx, subject, series)
	for _, item := range items {
		if item.Episode == 2 {
			t.Fatalf("unwatched episode must be cleared: %+v", item)
		}
	}
}

func TestSyncOfflineAppliesNewerAndNeverUncompletes(t *testing.T) {
	store := newCharacterizationStore(t)
	ctx := context.Background()
	subject, series := t.Name(), "tmdb:tv:2"

	// No server record: offline progress is applied.
	applied, err := store.SyncOffline(ctx, subject, []OfflineProgress{
		{SeriesID: series, Season: 1, Episode: 1, PositionS: 600, DurationS: 1200, WatchedAt: time.Now().Add(-time.Hour)},
	})
	if err != nil || applied != 1 {
		t.Fatalf("first sync applied=%d err=%v", applied, err)
	}
	// Server has newer progress: an older offline position is ignored.
	if err := store.SaveProgress(ctx, subject, series, 1, 1, 900, 1200); err != nil {
		t.Fatalf("online save: %v", err)
	}
	applied, _ = store.SyncOffline(ctx, subject, []OfflineProgress{
		{SeriesID: series, Season: 1, Episode: 1, PositionS: 300, DurationS: 1200, WatchedAt: time.Now().Add(-2 * time.Hour)},
	})
	if applied != 0 {
		t.Fatalf("older offline position must not overwrite newer server progress")
	}
	// Offline completion wins over partial server progress.
	applied, _ = store.SyncOffline(ctx, subject, []OfflineProgress{
		{SeriesID: series, Season: 1, Episode: 1, PositionS: 1150, DurationS: 1200, WatchedAt: time.Now().Add(-3 * time.Hour)},
	})
	if applied != 1 {
		t.Fatalf("offline completion must apply")
	}
	// A completed item never moves back to partial.
	applied, _ = store.SyncOffline(ctx, subject, []OfflineProgress{
		{SeriesID: series, Season: 1, Episode: 1, PositionS: 100, DurationS: 1200, WatchedAt: time.Now()},
	})
	items, _ := store.ListWatched(ctx, subject, series)
	if applied != 0 || len(items) != 1 || !items[0].Watched {
		t.Fatalf("completion must stick: applied=%d items=%+v", applied, items)
	}
}
