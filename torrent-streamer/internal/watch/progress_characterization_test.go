package watch

import (
	"context"
	"os"
	"testing"
	"time"
)

// Characterization of the CURRENT (pre-005) DB-level progress behavior,
// captured before the ordered-write rewrite (T051). These tests run only
// against a disposable PostgreSQL instance provided via TORWATCH_TEST_PG_DSN;
// they are skipped (recorded as pending, never passed) when no disposable
// database is available.
func newCharacterizationStore(t *testing.T) *Store {
	t.Helper()
	dsn := os.Getenv("TORWATCH_TEST_PG_DSN")
	if dsn == "" {
		t.Skip("TORWATCH_TEST_PG_DSN not set; DB-level characterization pending a disposable database")
	}
	store, err := NewTestStore(context.Background(), dsn)
	if err != nil {
		t.Fatalf("configured test database failed: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func TestCharacterizationLWWOverwriteByCommitOrder(t *testing.T) {
	store := newCharacterizationStore(t)
	ctx := context.Background()
	subject, series := "char-subject", "char-series-1"

	if err := store.SaveProgress(ctx, subject, series, 1, 1, 300, 1440); err != nil {
		t.Fatalf("first save: %v", err)
	}
	if err := store.SaveProgress(ctx, subject, series, 1, 1, 900, 1440); err != nil {
		t.Fatalf("second save: %v", err)
	}
	resume, found, err := store.GetResume(ctx, subject, series)
	if err != nil || !found {
		t.Fatalf("resume = %+v, %v", resume, err)
	}
	if resume.Position != 900 {
		t.Fatalf("LWW by commit order: last write (900) must win, got %d", resume.Position)
	}
}

func TestCharacterizationDeliberatePositionRegressionIsAValidWrite(t *testing.T) {
	store := newCharacterizationStore(t)
	ctx := context.Background()
	subject, series := "char-subject", "char-series-2"

	if err := store.SaveProgress(ctx, subject, series, 1, 1, 900, 1440); err != nil {
		t.Fatalf("first save: %v", err)
	}
	// Furthest-position-wins is prohibited: an explicit later write with a
	// lower position must overwrite (intentional rewind / episode restart).
	if err := store.SaveProgress(ctx, subject, series, 1, 1, 120, 1440); err != nil {
		t.Fatalf("rewind save: %v", err)
	}
	resume, found, _ := store.GetResume(ctx, subject, series)
	if !found || resume.Position != 120 {
		t.Fatalf("rewind must overwrite: %+v (found=%v)", resume, found)
	}
}

func TestCharacterizationResumeSelectionRules(t *testing.T) {
	store := newCharacterizationStore(t)
	ctx := context.Background()
	subject := "char-subject"

	if err := store.SaveProgress(ctx, subject, "char-series-3", 1, 1, 0, 1440); err != nil {
		t.Fatalf("zero-position save: %v", err)
	}
	if _, found, _ := store.GetResume(ctx, subject, "char-series-3"); found {
		t.Fatal("position_s = 0 rows are not resumable")
	}

	if err := store.SaveProgress(ctx, subject, "char-series-4", 1, 1, 1441, 1440); err != nil {
		t.Fatalf("completed save: %v", err)
	}
	if _, found, _ := store.GetResume(ctx, subject, "char-series-4"); found {
		t.Fatal("percent >= 95 rows are not resumable")
	}

	if err := store.SaveProgress(ctx, subject, "char-series-5", 2, 3, 500, 1440); err != nil {
		t.Fatalf("latest save: %v", err)
	}
	time.Sleep(10 * time.Millisecond)
	if err := store.SaveProgress(ctx, subject, "char-series-5", 2, 4, 700, 1440); err != nil {
		t.Fatalf("newer save: %v", err)
	}
	resume, found, _ := store.GetResume(ctx, subject, "char-series-5")
	if !found || resume.Episode != 4 || resume.Position != 700 {
		t.Fatalf("resume must pick the latest updated row: %+v", resume)
	}
}

func TestCharacterizationNextEpisodeQueueingAtCompletion(t *testing.T) {
	store := newCharacterizationStore(t)
	ctx := context.Background()
	subject, series := "char-subject", "char-series-6"

	if _, err := store.SaveProgressUpdate(ctx, ProgressUpdate{
		SubjectID: subject, SeriesID: series, Season: 1, Episode: 1,
		Position: 1440, Duration: 1440,
		Next: &EpisodeRef{Season: 1, Episode: 2},
	}); err != nil {
		t.Fatalf("completed save with next: %v", err)
	}
	if err := store.Dismiss(ctx, subject, series, 1, 2, "manual"); err != nil {
		t.Fatalf("dismiss next: %v", err)
	}
	if _, err := store.SaveProgressUpdate(ctx, ProgressUpdate{
		SubjectID: subject, SeriesID: series, Season: 1, Episode: 1,
		Position: 1400, Duration: 1440,
		Next: &EpisodeRef{Season: 1, Episode: 2},
	}); err != nil {
		t.Fatalf("re-complete: %v", err)
	}
	items, err := store.ListContinue(ctx, subject, 30)
	if err != nil {
		t.Fatalf("continue list: %v", err)
	}
	foundQueued := false
	for _, item := range items {
		if item.SeriesID == series && item.Season == 1 && item.Episode == 2 {
			foundQueued = true
		}
	}
	if !foundQueued {
		t.Fatalf("next episode must be queued and its dismissal cleared: %+v", items)
	}
}

func TestCharacterizationSourceSnapshotRoundTrip(t *testing.T) {
	store := newCharacterizationStore(t)
	ctx := context.Background()
	subject, series := "char-subject", "char-series-7"
	fileIndex := 3

	if _, err := store.SaveProgressUpdate(ctx, ProgressUpdate{
		SubjectID: subject, SeriesID: series, Season: 1, Episode: 1,
		Position: 500, Duration: 1440,
		Source: &ProgressSource{URI: "magnet:?xt=urn:btih:ABC", Name: "Episode 1.mkv", Kind: "magnet", FileIndex: &fileIndex},
	}); err != nil {
		t.Fatalf("save with source: %v", err)
	}
	source, found, err := store.GetProgressSource(ctx, subject, series, 1, 1)
	if err != nil || !found {
		t.Fatalf("source = %+v found=%v err=%v", source, found, err)
	}
	if source.URI != "magnet:?xt=urn:btih:ABC" || source.Name != "Episode 1.mkv" || source.Kind != "magnet" || source.FileIndex == nil || *source.FileIndex != 3 {
		t.Fatalf("source snapshot round trip wrong: %+v", source)
	}
}
