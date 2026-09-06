package watch

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestFailedSetupReleasesCapacity(t *testing.T) {
	setupErr := errors.New("setup failed")
	m := NewManager(time.Hour, time.Hour, func(k Key) error {
		if k.ID == "bad" {
			return setupErr
		}
		return nil
	}, nil)
	t.Cleanup(m.Shutdown)
	m.SetMaxActiveTitles(1)
	if _, err := m.Open(context.Background(), Key{ID: "bad"}, LeaseOptions{}); !errors.Is(err, setupErr) {
		t.Fatalf("Open(bad) = %v, want setup error", err)
	}
	if got := m.AdmissionSnapshot().ActiveKeys; got != 0 {
		t.Fatalf("active resources after failure = %d, want 0", got)
	}
	if _, err := m.Open(context.Background(), Key{ID: "good"}, LeaseOptions{}); err != nil {
		t.Fatalf("Open(good) after failed setup = %v", err)
	}
}

func TestConcurrentSameKeySharesSetupAndReleasesOnce(t *testing.T) {
	var ensures, stops atomic.Int32
	started, finish := make(chan struct{}), make(chan struct{})
	var unblock sync.Once
	m := NewManager(time.Hour, time.Hour, func(Key) error {
		if ensures.Add(1) == 1 {
			close(started)
		}
		<-finish
		return nil
	}, func(Key) { stops.Add(1) })
	t.Cleanup(m.Shutdown)
	t.Cleanup(func() { unblock.Do(func() { close(finish) }) })
	m.SetMaxActiveTitles(1)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	type result struct {
		lease string
		err   error
	}
	const clients = 8
	// One result slot per client lets every worker finish even on test failure.
	results := make(chan result, clients)
	for range clients {
		go func() {
			lease, err := m.Open(ctx, Key{ID: "shared"}, LeaseOptions{})
			results <- result{lease, err}
		}()
	}
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("setup did not start")
	}
	if _, err := m.Open(ctx, Key{ID: "other"}, LeaseOptions{}); !errors.Is(err, ErrCapacityExceeded) {
		t.Errorf("Open(other) during setup = %v, want capacity exceeded", err)
	}
	// Reaping must not discard an in-flight reservation.
	m.reap(time.Now().Add(2 * time.Hour))
	unblock.Do(func() { close(finish) })
	for range clients {
		select {
		case got := <-results:
			if got.err != nil {
				t.Fatalf("Open(shared) = %v", got.err)
			}
			m.Close(ctx, got.lease)
		case <-ctx.Done():
			t.Fatal("concurrent opens did not finish")
		}
	}
	m.reap(time.Now())
	if ensures.Load() != 1 || stops.Load() != 1 || m.AdmissionSnapshot().ActiveKeys != 0 {
		t.Fatalf("shared lifecycle: ensures=%d stops=%d snapshot=%+v", ensures.Load(), stops.Load(), m.AdmissionSnapshot())
	}
	if _, err := m.Open(ctx, Key{ID: "other"}, LeaseOptions{}); err != nil {
		t.Fatalf("Open(other) after final release = %v", err)
	}
}

func TestTeardownKeepsReservationAndWaitCanBeCanceled(t *testing.T) {
	var ensures atomic.Int32
	stopping, finish := make(chan struct{}), make(chan struct{})
	var unblock sync.Once
	m := NewManager(time.Hour, time.Hour, func(Key) error { ensures.Add(1); return nil }, func(Key) {
		close(stopping)
		<-finish
	})
	t.Cleanup(m.Shutdown)
	t.Cleanup(func() { unblock.Do(func() { close(finish) }) })
	m.SetMaxActiveTitles(1)
	key := Key{ID: "shared"}
	lease, err := m.Open(context.Background(), key, LeaseOptions{})
	if err != nil {
		t.Fatal(err)
	}
	m.Close(context.Background(), lease)
	reaped := make(chan struct{})
	go func() { defer close(reaped); m.reap(time.Now()) }()
	select {
	case <-stopping:
	case <-time.After(5 * time.Second):
		t.Fatal("teardown did not start")
	}
	if _, err := m.Open(context.Background(), Key{ID: "other"}, LeaseOptions{}); !errors.Is(err, ErrCapacityExceeded) {
		t.Errorf("Open(other) during teardown = %v, want capacity exceeded", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := m.Open(ctx, key, LeaseOptions{}); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("Open(shared) during teardown = %v, want deadline exceeded", err)
	}
	if ensures.Load() != 1 {
		t.Errorf("setup ran before teardown finished: %d calls", ensures.Load())
	}
	unblock.Do(func() { close(finish) })
	select {
	case <-reaped:
	case <-time.After(5 * time.Second):
		t.Fatal("teardown did not finish")
	}
	if _, err := m.Open(context.Background(), key, LeaseOptions{}); err != nil {
		t.Fatal(err)
	}
	if ensures.Load() != 2 {
		t.Errorf("setup count after reopen = %d, want 2", ensures.Load())
	}
}

func TestSlowSetupDoesNotBlockExistingHeartbeat(t *testing.T) {
	started, finish := make(chan struct{}), make(chan struct{})
	var unblock sync.Once
	m := NewManager(time.Hour, time.Hour, func(k Key) error {
		if k.ID == "slow" {
			close(started)
			<-finish
		}
		return nil
	}, nil)
	t.Cleanup(m.Shutdown)
	t.Cleanup(func() { unblock.Do(func() { close(finish) }) })
	m.SetMaxActiveTitles(2)
	lease, err := m.Open(context.Background(), Key{ID: "active"}, LeaseOptions{})
	if err != nil {
		t.Fatal(err)
	}
	opened := make(chan error, 1)
	go func() { _, err := m.Open(context.Background(), Key{ID: "slow"}, LeaseOptions{}); opened <- err }()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("setup did not start")
	}
	pinged := make(chan bool, 1)
	go func() { pinged <- m.Ping(context.Background(), lease) }()
	select {
	case ok := <-pinged:
		if !ok {
			t.Error("existing lease was lost")
		}
	case <-time.After(time.Second):
		t.Error("heartbeat blocked on another resource's setup")
	}
	unblock.Do(func() { close(finish) })
	if err := <-opened; err != nil {
		t.Fatal(err)
	}
}
