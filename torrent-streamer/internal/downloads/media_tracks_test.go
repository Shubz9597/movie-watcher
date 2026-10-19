package downloads

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// A dual-audio anime release: Japanese and English audio, English
// subtitles for each, the players' numbering kept (container order).
func TestProbeMediaTracksListsAudioAndSubtitlesInOrder(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
	dir := t.TempDir()
	srt := filepath.Join(dir, "in.srt")
	if err := os.WriteFile(srt, []byte("1\n00:00:01,000 --> 00:00:02,000\nKamehameha!\n\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	video := filepath.Join(dir, "video.mkv")
	build := exec.Command("ffmpeg", "-v", "error",
		"-f", "lavfi", "-i", "color=c=black:s=64x48:d=3",
		"-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=5.1",
		"-i", srt, "-i", srt, "-t", "3",
		"-map", "0", "-map", "1", "-map", "2", "-map", "3", "-map", "4",
		"-c:v", "mpeg4", "-c:a", "ac3", "-c:s", "srt",
		"-metadata:s:a:0", "language=jpn", "-metadata:s:a:1", "language=eng", "-metadata:s:a:1", "title=English Dub",
		"-metadata:s:s:0", "language=eng", "-metadata:s:s:0", "title=Full Subtitles",
		"-metadata:s:s:1", "language=eng", "-metadata:s:s:1", "title=English Dubtitles",
		"-disposition:a:0", "default", "-disposition:s:1", "hearing_impaired",
		video)
	if out, err := build.CombinedOutput(); err != nil {
		t.Skipf("cannot build fixture: %v %s", err, out)
	}
	tracks, err := ProbeMediaTracks(context.Background(), video, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if len(tracks.Audio) != 2 || len(tracks.Subtitles) != 2 {
		t.Fatalf("tracks = %+v", tracks)
	}
	if a := tracks.Audio[0]; a.Language != "jpn" || !a.Default || a.Channels != 2 {
		t.Fatalf("first audio = %+v", a)
	}
	if a := tracks.Audio[1]; a.Language != "eng" || a.Title != "English Dub" || a.Channels != 6 || a.Default {
		t.Fatalf("second audio = %+v", a)
	}
	if s := tracks.Subtitles[1]; s.Title != "English Dubtitles" || !s.CC || s.Codec != "subrip" {
		t.Fatalf("second subtitle = %+v", s)
	}
}

func TestParseMediaTracksDropsUndeterminedLanguage(t *testing.T) {
	tracks, err := parseMediaTracks([]byte(`{"streams":[{"codec_type":"video","codec_name":"hevc"},
		{"codec_type":"audio","codec_name":"aac","channels":2,"tags":{"LANGUAGE":"und"}}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(tracks.Audio) != 1 || tracks.Audio[0].Language != "" || len(tracks.Subtitles) != 0 {
		t.Fatalf("tracks = %+v", tracks)
	}
}
