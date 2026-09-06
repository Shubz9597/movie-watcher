package watch

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"
)

func TestConcurrentFirstProgressWrites(t *testing.T) {
	for _, sameSession := range []bool{false, true} {
		t.Run(fmt.Sprintf("sameSession=%v", sameSession), func(t *testing.T) {
			store := newCharacterizationStore(t)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			const writers = 12
			type outcome struct {
				result SaveResult
				err    error
			}
			// One slot per writer allows every worker to finish before assertions.
			outcomes := make(chan outcome, writers)
			start := make(chan struct{})
			var wg sync.WaitGroup
			for i := range writers {
				wg.Add(1)
				go func(i int) {
					defer wg.Done()
					<-start
					session := fmt.Sprintf("session-%d", i)
					if sameSession {
						session = "shared-session"
					}
					result, err := store.SaveProgressUpdate(ctx, ProgressUpdate{
						SubjectID: t.Name(), SeriesID: "concurrent-first", Season: 1, Episode: 1,
						SessionID: session, Seq: 1, Position: 100 + i, Duration: 1000,
					})
					outcomes <- outcome{result, err}
				}(i)
			}
			close(start)
			wg.Wait()
			close(outcomes)
			accepted := 0
			for got := range outcomes {
				if got.err != nil {
					t.Fatalf("concurrent first write: %v", got.err)
				}
				if got.result.Ignored == "" {
					accepted++
				} else if got.result.Ignored != "stale_seq" {
					t.Errorf("ignored = %q", got.result.Ignored)
				}
			}
			want := writers
			if sameSession {
				want = 1
			}
			var revision, sessions int
			if err := store.DB.QueryRowContext(ctx, `SELECT progress_revision,
  (SELECT count(*) FROM watch_progress_sessions s WHERE s.progress_id=wp.id)
FROM watch_progress wp WHERE subject_id=$1 AND series_id='concurrent-first'`, t.Name()).Scan(&revision, &sessions); err != nil {
				t.Fatal(err)
			}
			if accepted != want || revision != want || sessions != want {
				t.Fatalf("accepted=%d revision=%d sessions=%d, want %d each", accepted, revision, sessions, want)
			}
		})
	}
}

func TestSessionSequencesSurviveStoreReopen(t *testing.T) {
	store := newCharacterizationStore(t)
	ctx := context.Background()
	update := ProgressUpdate{SubjectID: t.Name(), SeriesID: "reopen", Season: 1, Episode: 1, Duration: 1000}
	for _, checkpoint := range []struct {
		session string
		seq     int64
		pos     int
	}{
		{"a", 10, 600}, {"b", 1, 300}, {"b", 2, 200},
	} {
		update.SessionID, update.Seq, update.Position = checkpoint.session, checkpoint.seq, checkpoint.pos
		if result, err := store.SaveProgressUpdate(ctx, update); err != nil || result.Ignored != "" {
			t.Fatalf("save checkpoint: %+v %v", result, err)
		}
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	store = newCharacterizationStore(t)
	update.SessionID, update.Seq, update.Position = "a", 9, 900
	if result, err := store.SaveProgressUpdate(ctx, update); err != nil || result.Ignored != "stale_seq" {
		t.Fatalf("retry after reopen: %+v %v", result, err)
	}
	resume, found, err := store.GetResume(ctx, update.SubjectID, update.SeriesID)
	if err != nil || !found || resume.Position != 200 {
		t.Fatalf("resume after retry: %+v found=%v err=%v", resume, found, err)
	}
}

// Ordered-write semantics at the DB level (FR-006, contracts/leases-and-progress.md).
// Runs only against a disposable database (TORWATCH_TEST_PG_DSN); skipped
// otherwise (pending, never passed).
func TestOrderedProgressDBLevel(t *testing.T) {
	store := newCharacterizationStore(t)
	ctx := context.Background()
	subject, series := "ordered-subject", "ordered-series"

	// Heartbeat A seq 10 position 600 → accepted.
	result, err := store.SaveProgressUpdate(ctx, ProgressUpdate{
		SubjectID: subject, SeriesID: series, Season: 1, Episode: 1,
		Position: 600, Duration: 1440, ClientID: "client-a", SessionID: "session-a", Seq: 10,
	})
	if err != nil || result.Ignored != "" {
		t.Fatalf("A seq 10 = %+v, %v", result, err)
	}

	// Heartbeat B seq 5 (different session) → accepted, commit-order LWW.
	result, err = store.SaveProgressUpdate(ctx, ProgressUpdate{
		SubjectID: subject, SeriesID: series, Season: 1, Episode: 1,
		Position: 300, Duration: 1440, ClientID: "client-b", SessionID: "session-b", Seq: 5,
	})
	if err != nil || result.Ignored != "" {
		t.Fatalf("B seq 5 = %+v, %v", result, err)
	}
	resume, found, _ := store.GetResume(ctx, subject, series)
	if !found || resume.Position != 300 {
		t.Fatalf("commit-order LWW must store B's 300: %+v", resume)
	}

	// Heartbeat A seq 9 (delayed retry, same session) → ignored stale_seq;
	// stored progress must NOT move backward to 700.
	result, err = store.SaveProgressUpdate(ctx, ProgressUpdate{
		SubjectID: subject, SeriesID: series, Season: 1, Episode: 1,
		Position: 700, Duration: 1440, ClientID: "client-a", SessionID: "session-a", Seq: 9,
	})
	if err != nil || result.Ignored != "stale_seq" {
		t.Fatalf("A seq 9 retry = %+v, %v", result, err)
	}
	resume, found, _ = store.GetResume(ctx, subject, series)
	if !found || resume.Position != 300 {
		t.Fatalf("delayed retry must not change stored progress: %+v", resume)
	}

	// Heartbeat A seq 11 position 120 (deliberate rewind) → accepted.
	result, err = store.SaveProgressUpdate(ctx, ProgressUpdate{
		SubjectID: subject, SeriesID: series, Season: 1, Episode: 1,
		Position: 120, Duration: 1440, ClientID: "client-a", SessionID: "session-a", Seq: 11,
	})
	if err != nil || result.Ignored != "" {
		t.Fatalf("deliberate rewind = %+v, %v", result, err)
	}
	resume, found, _ = store.GetResume(ctx, subject, series)
	if !found || resume.Position != 120 {
		t.Fatalf("deliberate rewind must be stored: %+v", resume)
	}

	// Low-fidelity stream estimate must not overwrite the explicit-session row.
	result, err = store.SaveProgressUpdate(ctx, ProgressUpdate{
		SubjectID: subject, SeriesID: series, Season: 1, Episode: 1,
		Position: 800, Duration: 1440, LowFidelity: true,
	})
	if err != nil || result.Ignored != "stale_estimate" {
		t.Fatalf("stream estimate = %+v, %v", result, err)
	}
	resume, found, _ = store.GetResume(ctx, subject, series)
	if !found || resume.Position != 120 {
		t.Fatalf("estimate must not overwrite the heartbeat row: %+v", resume)
	}
}

// TestOrderedProgressRevisionMonotonic verifies the monotonic revision chain.
func TestOrderedProgressRevisionMonotonic(t *testing.T) {
	store := newCharacterizationStore(t)
	ctx := context.Background()
	subject, series := "ordered-subject", "revision-series"

	lastRevision := int64(0)
	for seq := int64(1); seq <= 3; seq++ {
		if _, err := store.SaveProgressUpdate(ctx, ProgressUpdate{
			SubjectID: subject, SeriesID: series, Season: 1, Episode: 1,
			Position: int(seq) * 100, Duration: 1440, SessionID: "s", Seq: seq,
		}); err != nil {
			t.Fatalf("write %d: %v", seq, err)
		}
		var revision int64
		if err := store.DB.QueryRowContext(ctx, `
SELECT progress_revision FROM watch_progress
WHERE subject_id=$1 AND series_id=$2 AND season=1 AND episode=1`, subject, series).Scan(&revision); err != nil {
			t.Fatalf("read revision: %v", err)
		}
		if revision != lastRevision+1 {
			t.Fatalf("revision not monotonic: %d after %d", revision, lastRevision)
		}
		lastRevision = revision
	}
}
