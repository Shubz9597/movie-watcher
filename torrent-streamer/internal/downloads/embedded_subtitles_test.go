package downloads

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestPickEmbeddedSubtitleTakesTheFullDialogueTrack(t *testing.T) {
	tracks := []embeddedSubtitle{
		{Index: 2, Codec: "hdmv_pgs_subtitle", Lang: "eng"},
		{Index: 3, Codec: "ass", Lang: "eng", Title: "Signs & Songs"},
		{Index: 4, Codec: "subrip", Lang: "eng", SDH: true},
		{Index: 5, Codec: "subrip", Lang: "eng", Title: "Full"},
		{Index: 6, Codec: "subrip", Lang: "spa"},
	}
	if got, ok := pickEmbeddedSubtitle(tracks, "en"); !ok || got.Index != 5 {
		t.Fatalf("picked %+v, %v; want the non-SDH full English text track (5)", got, ok)
	}
	if got, ok := pickEmbeddedSubtitle(tracks, "es"); !ok || got.Index != 6 {
		t.Fatalf("picked %+v, %v; want Spanish (6)", got, ok)
	}
	if _, ok := pickEmbeddedSubtitle(tracks[:2], "en"); ok {
		t.Fatal("picture subtitles and signs-only tracks must not be used")
	}
	if _, ok := pickEmbeddedSubtitle([]embeddedSubtitle{{Index: 2, Codec: "subrip", Lang: "eng", Forced: true}}, "en"); ok {
		t.Fatal("a forced track carries only part of the dialogue")
	}
}

func TestExtractEmbeddedSubtitleFromMatroska(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
	dir := t.TempDir()
	srt := filepath.Join(dir, "in.srt")
	if err := os.WriteFile(srt, []byte("1\n00:00:03,754 --> 00:00:06,047\nIt looked as though Yamcha\n\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	video := filepath.Join(dir, "video.mkv")
	build := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x48:d=8", "-i", srt,
		"-map", "0", "-map", "1", "-c:v", "mpeg4", "-c:s", "srt", "-metadata:s:s:0", "language=eng", video)
	if out, err := build.CombinedOutput(); err != nil {
		t.Skipf("cannot build fixture: %v %s", err, out)
	}
	vtt, err := extractEmbeddedSubtitle(context.Background(), video, "en")
	if err != nil {
		t.Fatal(err)
	}
	if text := string(vtt); !strings.HasPrefix(text, "WEBVTT") || !strings.Contains(text, "00:03.754 --> 00:06.047") || !strings.Contains(text, "Yamcha") {
		t.Fatalf("vtt = %q", text)
	}
	if _, err := extractEmbeddedSubtitle(context.Background(), video, "ja"); err == nil {
		t.Fatal("a missing language must report an error")
	}
}
