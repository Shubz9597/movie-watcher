package playback

import (
	"context"
	"testing"
	"time"
)

// A session that is still being read never expires mid-playback: the TTL
// slides from the last request, while an idle session still expires.
func TestSessionTTLSlidesWhileServing(t *testing.T) {
	const hash = "0123456789abcdef0123456789abcdef01234567"
	state := &sharedProbeState{}
	resolver := &fakeResolver{sources: map[string]ResolvedSource{hash: mkvSource("slide")},
		probeFor: map[string]*MediaInfo{hash: mkvH264AAC()}, current: state}
	m := newTestManager(t, &sharedProber{state}, resolver)
	view, err := m.Create(context.Background(), "movie", hash, 0, "ios-avplayer")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	// Keep reading for well past the 50ms TTL.
	for i := 0; i < 6; i++ {
		time.Sleep(20 * time.Millisecond)
		if _, ok := m.Lookup(view.SessionID); !ok {
			t.Fatalf("session expired after %dms of continuous serving", (i+1)*20)
		}
	}
	time.Sleep(80 * time.Millisecond)
	if _, ok := m.Lookup(view.SessionID); ok {
		t.Fatal("an idle session must still expire after the TTL")
	}
}
