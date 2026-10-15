package downloads

import (
	"context"
	"testing"
)

// The video's own track is chosen without being copied: Dragon Ball Z Kai
// downloads listed their English subtitle twice ("English" and "English ·
// Downloaded").
func TestOwnTrackNeedsNoCopy(t *testing.T) {
	choice, ok := chooseSubtitle(context.Background(), "job", "/nonexistent.mkv", "en", []byte("WEBVTT\n\n00:01.000 --> 00:02.000\nHi\n"), nil)
	if !ok || !choice.own {
		t.Fatalf("choice = %+v ok=%v, want the video's own track (no copy)", choice, ok)
	}
	if choice, ok := fallbackSubtitle(nil, []ProviderSubtitle{{Name: "a", Data: []byte("x"), Ext: "srt"}}); !ok || choice.own {
		t.Fatalf("a provider subtitle is saved: %+v", choice)
	}
}
