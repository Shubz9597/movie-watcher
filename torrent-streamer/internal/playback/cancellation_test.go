package playback

import (
	"context"
	"io"
	"net/http"
	"sync"
	"testing"
	"time"
)

type blockedMediaReader struct {
	ctx     context.Context
	started chan struct{}
	once    sync.Once
}

func (r *blockedMediaReader) SetContext(ctx context.Context) { r.ctx = ctx }
func (r *blockedMediaReader) Read([]byte) (int, error) {
	r.once.Do(func() { close(r.started) })
	<-r.ctx.Done()
	return 0, r.ctx.Err()
}
func (r *blockedMediaReader) Seek(offset int64, whence int) (int64, error) {
	if whence == io.SeekEnd {
		return 1024 + offset, nil
	}
	return offset, nil
}
func (r *blockedMediaReader) Close() error { return nil }

func TestMediaSourceRevocationInterruptsBlockedRead(t *testing.T) {
	ms, err := NewMediaSource()
	if err != nil {
		t.Fatal(err)
	}
	defer ms.Close()
	reader := &blockedMediaReader{started: make(chan struct{})}
	token, url, err := ms.Issue(func() (io.ReadSeekCloser, error) { return reader, nil }, "video.mp4", 1024, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			defer resp.Body.Close()
			io.Copy(io.Discard, resp.Body)
		}
	}()
	select {
	case <-reader.started:
	case <-ctx.Done():
		t.Fatal("reader did not start")
	}
	ms.Revoke(token)
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("revocation did not cancel blocked source reader")
	}
}

func TestDirectReaderCancelledWhenSessionDeleted(t *testing.T) {
	lifetime, cancel := context.WithCancel(context.Background())
	s := &session{lifetime: lifetime, cancel: cancel}
	r := &blockedMediaReader{started: make(chan struct{})}
	release := s.BindMediaReader(context.Background(), r)
	defer release()
	done := make(chan struct{})
	go func() { defer close(done); r.Read(make([]byte, 1)) }()
	<-r.started
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("session deletion did not cancel direct read")
	}
}

func TestSidecarReadUsesCreationContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	r := &blockedMediaReader{started: make(chan struct{})}
	done := make(chan bool, 1)
	go func() { _, ok := readBounded(ctx, func() (io.ReadCloser, error) { return r, nil }); done <- ok }()
	<-r.started
	cancel()
	select {
	case ok := <-done:
		if ok {
			t.Fatal("cancelled read succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("sidecar read survived cancellation")
	}
}
