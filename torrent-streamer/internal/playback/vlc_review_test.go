package playback

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestVLCSessionPreservesStyledSidecarsWithoutFFmpeg(t *testing.T) {
	for _, profile := range []string{"ios-vlc", "android-vlc"} {
		t.Run(profile, func(t *testing.T) {
			const id = "0123456789abcdef0123456789abcdef01234567"
			const ass = "[Script Info]\nTitle: Styled subtitle\n[V4+ Styles]\nStyle: Default,Arial,24\n"
			state := &sharedProbeState{}
			src := mkvSource("vlc")
			src.Sidecars = []Sidecar{{Format: "ass", Label: "Styled", Open: func() (io.ReadCloser, error) {
				return io.NopCloser(strings.NewReader(ass)), nil
			}}}
			resolver := &fakeResolver{sources: map[string]ResolvedSource{id: src}, probeFor: map[string]*MediaInfo{id: mkvH264AAC()}, current: state}
			m := newTestManager(t, &sharedProber{state}, resolver)
			defer m.Stop()
			m.tools.FFmpegPath = ""
			m.cfg.TranscodeDisabled = true
			view, err := m.Create(context.Background(), "movie", id, 0, profile)
			if err != nil {
				t.Fatalf("Create(%s): %v", profile, err)
			}
			if view.Mode != ModeDirect || len(view.Subtitles) != 1 {
				t.Fatalf("Create(%s) mode=%s subtitles=%v; want direct with ASS", profile, view.Mode, view.Subtitles)
			}
			sess, ok := m.Lookup(view.SessionID)
			if !ok {
				t.Fatal("session missing")
			}
			if got := sess.runner.(*fakeSessionRunner).started; got != 0 {
				t.Fatalf("FFmpeg starts=%d, want 0", got)
			}
			data, err := os.ReadFile(filepath.Join(sess.dir, "t0.ass"))
			if err != nil || string(data) != ass {
				t.Fatalf("ASS delivery=%q err=%v; want original bytes", data, err)
			}
		})
	}
}
