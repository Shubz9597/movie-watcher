package playback

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// M1.4 repair: EVERY generated fixture subtitle format must be discoverable
// by FixtureResolver (SRT, WebVTT, ASS), with human-safe labels that never
// leak the fixture identifier. No FFmpeg required — the resolver is pure
// filesystem logic.
func TestFixtureResolverDiscoversAllSubtitleFormats(t *testing.T) {
	root := t.TempDir()
	const mediaID = "1111111111111111111111111111111111111111"
	if err := os.WriteFile(filepath.Join(root, mediaID+".mp4"), []byte("fake-video"), 0o644); err != nil {
		t.Fatalf("media: %v", err)
	}
	for name, content := range map[string]string{
		mediaID + ".srt": "1\n00:00:00,500 --> 00:00:01,000\nHello\n",
		mediaID + ".vtt": "WEBVTT\n\n00:00:00.500 --> 00:00:01.000\nHello\n",
		mediaID + ".ass": "[Script Info]\nDialogue: 0,0:00:00.50,0:00:01.00,Default,,0,0,0,,Hello\n",
	} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	// A differently-prefixed sidecar must NOT attach (bounded to the source).
	if err := os.WriteFile(filepath.Join(root, "2222222222222222222222222222222222222222.srt"), []byte("other"), 0o644); err != nil {
		t.Fatalf("other sidecar: %v", err)
	}

	resolver := &FixtureResolver{Root: root}
	resolved, err := resolver.Resolve(context.Background(), "movie", mediaID, 0)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if len(resolved.Sidecars) != 3 {
		t.Fatalf("sidecars = %d, want 3 (srt+vtt+ass)", len(resolved.Sidecars))
	}
	formats := map[string]bool{}
	for _, sidecar := range resolved.Sidecars {
		formats[sidecar.Format] = true
		if strings.Contains(sidecar.Label, mediaID) {
			t.Fatalf("sidecar label leaks the fixture identifier: %q", sidecar.Label)
		}
		reader, openErr := sidecar.Open()
		if openErr != nil {
			t.Fatalf("sidecar %s open: %v", sidecar.Format, openErr)
		}
		data, err := io.ReadAll(reader)
		_ = reader.Close()
		if err != nil || len(data) == 0 {
			t.Fatalf("sidecar %s unreadable: %v", sidecar.Format, err)
		}
	}
	for _, want := range []string{"srt", "vtt", "ass"} {
		if !formats[want] {
			t.Fatalf("missing sidecar format %s", want)
		}
	}

	// Traversal-shaped identifiers are refused outright.
	if _, err := resolver.Resolve(context.Background(), "movie", "../escape", 0); err == nil {
		t.Fatal("traversal identifier must be rejected")
	}
	// Unknown media → bounded error.
	if _, err := resolver.Resolve(context.Background(), "movie", "3333333333333333333333333333333333333333", 0); err == nil {
		t.Fatal("missing media must produce a bounded error")
	}
}
