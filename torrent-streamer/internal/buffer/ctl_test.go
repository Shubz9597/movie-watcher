package buffer

import (
	"context"
	"testing"
	"time"
)

func TestWarmStateDoesNotDeadlockController(t *testing.T) {
	controller := &Controller{
		state:          StatePaused,
		rollingBps:     1024,
		targetAheadSec: 1,
	}
	done := make(chan int64)
	go func() {
		_, _, target := controller.warmState()
		done <- target
	}()

	select {
	case target := <-done:
		if target <= 0 {
			t.Fatalf("target = %d, want positive", target)
		}
	case <-time.After(time.Second):
		t.Fatal("warmState deadlocked the buffer controller")
	}

	controller.SetPlayhead(42)
	if got := controller.Playhead(); got != 42 {
		t.Fatalf("playhead = %d, want 42", got)
	}
}

func TestStopTorrentCancelsMatchingWarmer(t *testing.T) {
	workerCtx, cancelWorker := context.WithCancel(context.Background())
	workerDone := make(chan struct{})
	controller := &Controller{
		state:      StatePaused,
		warmCancel: cancelWorker,
		warmDone:   workerDone,
	}
	go func() {
		<-workerCtx.Done()
		close(workerDone)
	}()

	k := Key{Cat: "movie", IH: "STOP-TEST", FIdx: 0}
	bufMu.Lock()
	ctrls[k] = controller
	bufMu.Unlock()
	t.Cleanup(func() {
		bufMu.Lock()
		delete(ctrls, k)
		bufMu.Unlock()
	})

	if err := StopTorrent(context.Background(), k.Cat, k.IH); err != nil {
		t.Fatalf("StopTorrent(%q, %q) error = %v, want nil", k.Cat, k.IH, err)
	}
	if got := controller.State(); got != StateStopped {
		t.Errorf("Controller.State() = %q, want %q", got, StateStopped)
	}
}
