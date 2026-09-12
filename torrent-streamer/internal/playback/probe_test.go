package playback

import (
	"context"
	"strings"
	"testing"
	"time"
)

// Synthetic ffprobe JSON — deterministic, no media files required.
const probeJSON = `{
  "format": {"format_name": "mov,mp4,m4a,3gp,3g2,mj2", "duration": "42.5", "bit_rate": "4200000"},
  "streams": [
    {"index": 0, "codec_type": "video", "codec_name": "h264", "profile": "High",
     "level": 40, "width": 1920, "height": 1080, "pix_fmt": "yuv420p",
     "tags": {"language": "und"}},
    {"index": 1, "codec_type": "audio", "codec_name": "aac", "channels": 2},
    {"index": 2, "codec_type": "subtitle", "codec_name": "subrip",
     "tags": {"language": "eng", "title": "English"},
     "disposition": {"default": 1, "forced": 0}},
    {"index": 3, "codec_type": "subtitle", "codec_name": "hdmv_pgs_subtitle",
     "disposition": {"default": 0, "forced": 0}}
  ]
}`

// Replace the exec-based probe with a parse test (the exec boundary itself is
// exercised in the Docker integration run).
func TestParseFFprobeJSON(t *testing.T) {
	info, err := parseFFprobeJSON([]byte(probeJSON))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if info.Container != "mov" {
		t.Fatalf("container = %s", info.Container)
	}
	if normalizeContainer(info.Container) != "mp4" {
		t.Fatalf("normalized container = %s", normalizeContainer(info.Container))
	}
	if info.DurationSec != 42.5 || info.BitrateBps != 4200000 {
		t.Fatalf("duration/bitrate = %v/%v", info.DurationSec, info.BitrateBps)
	}
	if info.Video.Codec != "h264" || info.Video.Profile != "High" || info.Video.BitDepth != 8 {
		t.Fatalf("video = %+v", info.Video)
	}
	if info.Width != 1920 || info.Height != 1080 {
		t.Fatalf("dimensions = %dx%d", info.Width, info.Height)
	}
	if info.Audio.Codec != "aac" || info.Audio.Channels != 2 {
		t.Fatalf("audio = %+v", info.Audio)
	}
	if len(info.SubtitleWire) != 2 {
		t.Fatalf("subtitle tracks = %d", len(info.SubtitleWire))
	}
	if info.SubtitleWire[0].Format != "srt" || !info.SubtitleWire[0].Default {
		t.Fatalf("srt track = %+v", info.SubtitleWire[0])
	}
	// PGS is recognized and normalized so the planner/consumer can refuse it
	// truthfully.
	if info.SubtitleWire[1].Format != "pgs" {
		t.Fatalf("pgs track = %+v", info.SubtitleWire[1])
	}
}

func TestParseFFprobeJSONRejectsNoVideo(t *testing.T) {
	audioOnly := `{"format":{"format_name":"mp3","duration":"10"},"streams":[{"index":0,"codec_type":"audio","codec_name":"mp3"}]}`
	if _, err := parseFFprobeJSON([]byte(audioOnly)); err == nil {
		t.Fatal("audio-only input must be rejected as malformed")
	}
}

// ffprobe failure responses must not echo the (tokenized) URL.
func TestProbeErrorRedactsMediaURL(t *testing.T) {
	prober := &FFprobeProber{Tools: Tools{FFprobePath: "definitely-not-real"}, Timeout: 2 * time.Second}
	secretURL := "http://127.0.0.1:9/f/deadbeef-token-value"
	_, err := prober.Probe(context.Background(), secretURL)
	if err == nil {
		t.Fatal("expected probe failure")
	}
	if strings.Contains(err.Error(), "deadbeef") || strings.Contains(err.Error(), "127.0.0.1") {
		t.Fatalf("probe error leaked the media URL: %v", err)
	}
	if _, err := prober.Probe(context.Background(), ""); err == nil {
		t.Fatal("empty URL must fail")
	}
}

func TestBitDepthAndHDRParsing(t *testing.T) {
	if got := bitDepthFromPixFmt("yuv420p10le"); got != 10 {
		t.Fatalf("10-bit pix fmt depth = %d", got)
	}
	if got := hdrFromPixFmtAndTransfer("yuv420p10le", "smpte2084"); got != "hdr10" {
		t.Fatalf("hdr = %q", got)
	}
	if got := hdrFromPixFmtAndTransfer("yuv420p", ""); got != "" {
		t.Fatalf("sdr hdr = %q", got)
	}
}
