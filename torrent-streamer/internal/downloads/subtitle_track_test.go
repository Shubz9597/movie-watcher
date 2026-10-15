package downloads

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// A video with an SRT and an ASS track (as anime releases carry): the SRT
// comes back as WebVTT for the app to draw; the ASS one stays the player's.
func TestExtractSubtitleTrack(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
	dir := t.TempDir()
	srt := filepath.Join(dir, "en.srt")
	ass := filepath.Join(dir, "signs.ass")
	_ = os.WriteFile(srt, []byte("1\n00:00:01,000 --> 00:00:02,500\nI must confess, you're stronger\nthan I gave you credit for.\n"), 0o644)
	_ = os.WriteFile(ass, []byte("[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\pos(100,50)}Sign\n"), 0o644)
	video := filepath.Join(dir, "video.mkv")
	out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x48:d=3", "-i", srt, "-i", ass,
		"-map", "0", "-map", "1", "-map", "2", "-c:v", "mpeg4", "-c:s:0", "srt", "-c:s:1", "ass",
		"-metadata:s:s:0", "language=eng", video).CombinedOutput()
	if err != nil {
		t.Skipf("ffmpeg cannot build the sample: %v %s", err, out)
	}
	data, info, err := ExtractSubtitleTrack(context.Background(), video, 0)
	if err != nil || info.Lang != "eng" || !strings.Contains(string(data), "WEBVTT") || !strings.Contains(string(data), "than I gave you credit for.") {
		t.Fatalf("srt track: %v %+v %q", err, info, data)
	}
	if _, _, err := ExtractSubtitleTrack(context.Background(), video, 1); !errors.Is(err, ErrStyledSubtitle) {
		t.Fatalf("ass track: %v, want ErrStyledSubtitle", err)
	}
	if _, _, err := ExtractSubtitleTrack(context.Background(), video, 2); err == nil {
		t.Fatal("no third track")
	}
}
