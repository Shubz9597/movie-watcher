package downloads

import (
	"context"
	"database/sql"
	"os"
	"strings"
	"testing"
	"time"
)

func TestJobProgressFollowsStagesUntilCleared(t *testing.T) {
	const id = "progress-test-job"
	if _, ok := JobProgress(id); ok {
		t.Fatal("a job nobody prepares has no live progress")
	}
	setProgressStage(id, StageMetadata, nil, nil)
	if progress, ok := JobProgress(id); !ok || progress.Stage != StageMetadata {
		t.Fatalf("progress = %+v, %v", progress, ok)
	}
	setProgressStage(id, StageFinalizing, nil, nil)
	if progress, _ := JobProgress(id); progress.Stage != StageFinalizing {
		t.Fatalf("stage = %q", progress.Stage)
	}
	clearProgress(id)
	if _, ok := JobProgress(id); ok {
		t.Fatal("a finished job must drop its progress")
	}
}

func TestSampleRateSmoothsBytesPerSecond(t *testing.T) {
	entry := &progressEntry{}
	start := time.Unix(1000, 0)
	if rate := entry.sampleRate(0, start); rate != 0 {
		t.Fatalf("first sample rate = %d", rate)
	}
	if rate := entry.sampleRate(10<<20, start.Add(time.Second)); rate != 10<<20 {
		t.Fatalf("rate = %d, want 10 MiB/s", rate)
	}
	if rate := entry.sampleRate(10<<20, start.Add(1100*time.Millisecond)); rate != 10<<20 {
		t.Fatalf("a read within half a second keeps the last rate, got %d", rate)
	}
	if rate := entry.sampleRate(10<<20, start.Add(2*time.Second)); rate <= 0 || rate >= 10<<20 {
		t.Fatalf("a stall lowers the rate gradually, got %d", rate)
	}
}

func TestQueuedAheadCountsEarlierWaitingJobs(t *testing.T) {
	dsn := os.Getenv("TORWATCH_TEST_PG_DSN")
	if dsn == "" {
		t.Skip("TORWATCH_TEST_PG_DSN not set")
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	ctx := context.Background()
	store := NewStore(db)
	key := "queue-test-" + strings.ReplaceAll(time.Now().UTC().Format("150405.000000000"), ".", "-")
	create := func(suffix string) Job {
		job, _, err := store.Create(ctx, CreateRequest{
			ClientID: "1f0e3d1c-5a2b-4c7d-9e8f-0a1b2c3d4e5f", IdempotencyKey: key + suffix,
			SeriesID: "tmdb:movie:693134", PickID: 1,
		})
		if err != nil {
			t.Fatal(err)
		}
		return job
	}
	first := create("-a")
	time.Sleep(5 * time.Millisecond)
	second := create("-b")
	aheadFirst, err := store.QueuedAhead(ctx, first.ID)
	if err != nil {
		t.Fatal(err)
	}
	aheadSecond, err := store.QueuedAhead(ctx, second.ID)
	if err != nil || aheadSecond != aheadFirst+1 {
		t.Fatalf("ahead first=%d second=%d (%v); the second waits behind the first", aheadFirst, aheadSecond, err)
	}
}
