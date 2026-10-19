package downloads

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"torrent-streamer/internal/config"
)

// A download's own subtitles are read while it is prepared and kept, so the
// phone's subtitle box has them at once, even after the server's copy of
// the video is gone.
func TestSaveOwnTracksKeepsTextTracks(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
	t.Setenv("TORRENT_DATA_ROOT", t.TempDir())
	config.Load()
	dir := t.TempDir()
	srt := filepath.Join(dir, "in.srt")
	ass := filepath.Join(dir, "in.ass")
	if err := os.WriteFile(srt, []byte("1\n00:00:01,000 --> 00:00:02,000\nKamehameha!\n\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	assText := "[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize\nStyle: Default,Arial,20\n\n[Events]\nFormat: Layer, Start, End, Style, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,{\\pos(10,10)}SIGN\n"
	if err := os.WriteFile(ass, []byte(assText), 0o644); err != nil {
		t.Fatal(err)
	}
	video := filepath.Join(dir, "video.mkv")
	build := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x48:d=3",
		"-i", srt, "-i", ass, "-map", "0", "-map", "1", "-map", "2", "-c:v", "mpeg4", "-c:s:0", "srt", "-c:s:1", "ass",
		"-metadata:s:s:0", "language=eng", "-metadata:s:s:1", "language=eng", "-metadata:s:s:1", "title=Signs & Songs", video)
	if out, err := build.CombinedOutput(); err != nil {
		t.Skipf("cannot build fixture: %v %s", err, out)
	}
	hash := "D8AC608538FB8AB3D82A31097C5D67E10E27423C"
	if saved := SaveOwnTracks(context.Background(), video, hash, 1); saved != 1 {
		t.Fatalf("saved %d tracks, want the text one only", saved)
	}
	data, ok := SavedOwnTrack(strings.ToLower(hash), 1, 0)
	if !ok || !strings.Contains(string(data), "Kamehameha") {
		t.Fatalf("saved track = %q, %v", data, ok)
	}
	if _, ok := SavedOwnTrack(hash, 1, 1); ok {
		t.Fatal("a styled track stays with the player")
	}
	if _, ok := SavedOwnTrack(hash, 2, 0); ok {
		t.Fatal("another file of the torrent has its own tracks")
	}
}

func TestNormalizeInfoHash(t *testing.T) {
	hex := "d8ac608538fb8ab3d82a31097c5d67e10e27423c"
	if got := NormalizeInfoHash(strings.ToUpper(hex)); got != hex {
		t.Fatalf("hex = %q", got)
	}
	if got := NormalizeInfoHash("3CWGBBJY7OFLHWBKGEEXYXLH4EHCOQR4"); got != hex {
		t.Fatalf("base32 = %q", got)
	}
	if NormalizeInfoHash("magnet") != "" {
		t.Fatal("not a hash")
	}
}
