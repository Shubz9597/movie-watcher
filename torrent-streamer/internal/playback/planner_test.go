package playback

import (
	"context"
	"strings"
	"testing"
	"time"
)

func iosProfile() CapabilityProfile { return DefaultProfiles()["ios-avplayer"] }
func androidProfile() CapabilityProfile {
	return DefaultProfiles()["android-media3"]
}

func mp4H264AAC() *MediaInfo {
	return &MediaInfo{
		Container: "mp4", DurationSec: 600, Width: 1920, Height: 1080,
		Video:      VideoInfo{Codec: "h264", Profile: "High", BitDepth: 8},
		Audio:      AudioInfo{Codec: "aac", Channels: 2},
		BitrateBps: 5_000_000,
	}
}

func mkvH264AAC() *MediaInfo {
	info := mp4H264AAC()
	info.Container = "matroska"
	return info
}

func mkvMpeg4Video() *MediaInfo {
	info := mkvH264AAC()
	info.Video.Codec = "mpeg4"
	return info
}

// 1. compatible MP4 → direct plan.
func TestPlanCompatibleMP4IsDirect(t *testing.T) {
	decision := Plan(PlanInput{Info: mp4H264AAC(), Profile: iosProfile(), FFmpegReady: false})
	if decision.Mode != ModeDirect || decision.ReasonCode != ReasonCompatible {
		t.Fatalf("want direct/compatible, got %s/%s", decision.Mode, decision.ReasonCode)
	}
}

// 2. MKV + H.264/AAC → remux (stream copy) plan.
func TestPlanMKVWithCompatibleCodecsIsRemuxCopy(t *testing.T) {
	decision := Plan(PlanInput{Info: mkvH264AAC(), Profile: iosProfile(), FFmpegReady: true})
	if decision.Mode != ModeRemux || !decision.CopyVideo || !decision.CopyAudio {
		t.Fatalf("want remux with copy/copy, got %s copyVideo=%v copyAudio=%v", decision.Mode, decision.CopyVideo, decision.CopyAudio)
	}
	if decision.ReasonCode != ReasonContainerIncompatible {
		t.Fatalf("reason = %s", decision.ReasonCode)
	}
}

// 3. incompatible codec → transcode plan, bounded height.
func TestPlanIncompatibleCodecTranscodesBounded(t *testing.T) {
	info := mkvMpeg4Video()
	info.Height = 2160
	decision := Plan(PlanInput{Info: info, Profile: iosProfile(), FFmpegReady: true, MaxTranscodeHeight: 1080})
	if decision.Mode != ModeTranscode || decision.CopyVideo {
		t.Fatalf("want transcode with re-encoded video, got %s copyVideo=%v", decision.Mode, decision.CopyVideo)
	}
	if decision.MaxHeightPx != 1080 {
		t.Fatalf("transcode height bound = %d, want 1080", decision.MaxHeightPx)
	}
}

// 3b. incompatible AUDIO alone copies the video (remux with audio conversion).
func TestPlanIncompatibleAudioCopiesVideo(t *testing.T) {
	info := mkvH264AAC()
	info.Audio = AudioInfo{Codec: "dts", Channels: 6}
	decision := Plan(PlanInput{Info: info, Profile: iosProfile(), FFmpegReady: true})
	if decision.Mode != ModeRemux || !decision.CopyVideo || decision.CopyAudio {
		t.Fatalf("want remux copyVideo/convertAudio, got %s copyVideo=%v copyAudio=%v", decision.Mode, decision.CopyVideo, decision.CopyAudio)
	}
}

// 4. unsupported/malformed → bounded reason, never a crash.
func TestPlanMalformedAndMissingToolsAreBounded(t *testing.T) {
	if d := Plan(PlanInput{Info: nil, Profile: iosProfile(), FFmpegReady: true}); d.Mode != ModeUnsupported || d.ReasonCode != ReasonMediaInspectionFail {
		t.Fatalf("nil info: got %s/%s", d.Mode, d.ReasonCode)
	}
	noVideo := mp4H264AAC()
	noVideo.Video.Codec = ""
	if d := Plan(PlanInput{Info: noVideo, Profile: iosProfile()}); d.Mode != ModeUnsupported || d.ReasonCode != ReasonMalformedSource {
		t.Fatalf("no video: got %s/%s", d.Mode, d.ReasonCode)
	}
	// MKV needs conversion but FFmpeg is absent → unsupported with a clear reason.
	if d := Plan(PlanInput{Info: mkvH264AAC(), Profile: iosProfile(), FFmpegReady: false}); d.Mode != ModeUnsupported || d.ReasonCode != ReasonFFmpegMissing {
		t.Fatalf("no ffmpeg: got %s/%s", d.Mode, d.ReasonCode)
	}
	// Implausible dimensions are rejected as malformed.
	wild := mp4H264AAC()
	wild.Height = 999999
	if d := Plan(PlanInput{Info: wild, Profile: iosProfile()}); d.ReasonCode != ReasonMalformedSource {
		t.Fatalf("wild dimensions: got %s", d.ReasonCode)
	}
	// Direct is still available WITHOUT ffmpeg for compatible sources.
	if d := Plan(PlanInput{Info: mp4H264AAC(), Profile: iosProfile(), FFmpegReady: false}); d.Mode != ModeDirect {
		t.Fatalf("direct without ffmpeg: got %s", d.Mode)
	}
}

// 5. iOS versus Android capability differences.
func TestProfilesDifferPerPlatform(t *testing.T) {
	// MKV/opus/vp9 webm: Android (Media3) direct-plays VP9/Opus WebM; iOS does not.
	webm := mp4H264AAC()
	webm.Container = "webm"
	webm.Video.Codec = "vp9"
	webm.Audio.Codec = "opus"
	if d := Plan(PlanInput{Info: webm, Profile: androidProfile()}); d.Mode != ModeDirect {
		t.Fatalf("android webm/vp9/opus: got %s (%s)", d.Mode, d.ReasonCode)
	}
	if d := Plan(PlanInput{Info: webm, Profile: iosProfile(), FFmpegReady: true}); d.Mode != ModeRemux && d.Mode != ModeTranscode {
		t.Fatalf("ios webm/vp9/opus: got %s", d.Mode)
	}

	// HEVC: both profiles accept the codec, but HDR must follow the profile.
	hdr := mp4H264AAC()
	hdr.Video.Codec = "hevc"
	hdr.HDR = "hdr10"
	if d := Plan(PlanInput{Info: hdr, Profile: iosProfile()}); d.Mode != ModeDirect {
		t.Fatalf("ios hevc/hdr: got %s (%s)", d.Mode, d.ReasonCode)
	}
	if d := Plan(PlanInput{Info: hdr, Profile: androidProfile(), FFmpegReady: true}); d.Mode != ModeUnsupported || d.ReasonCode != ReasonHDRUnsupported {
		t.Fatalf("android hevc/hdr: got %s/%s", d.Mode, d.ReasonCode)
	}

	// Profiles stay contract data: both advertise HLS fMP4 + VTT.
	for name, p := range DefaultProfiles() {
		if !p.HLSfMP4 {
			t.Fatalf("%s must accept HLS fMP4", name)
		}
		if len(p.SubtitleFormats) == 0 || p.SubtitleFormats[0] != "vtt" {
			t.Fatalf("%s must accept WebVTT", name)
		}
	}
}

func TestPlanProfileResolutionAndBitrateLimitsTranscode(t *testing.T) {
	profile := iosProfile()
	profile.MaxHeightPx = 720
	profile.MaxBitrateBps = 2_000_000

	highResolution := mp4H264AAC()
	d := Plan(PlanInput{Info: highResolution, Profile: profile, FFmpegReady: true, MaxTranscodeHeight: 1080})
	if d.Mode != ModeTranscode || d.ReasonCode != ReasonResolutionExceeds || d.MaxHeightPx != 720 {
		t.Fatalf("resolution limit: got %s/%s height=%d", d.Mode, d.ReasonCode, d.MaxHeightPx)
	}

	highBitrate := mp4H264AAC()
	highBitrate.Width, highBitrate.Height = 640, 360
	d = Plan(PlanInput{Info: highBitrate, Profile: profile, FFmpegReady: true, MaxTranscodeHeight: 1080})
	if d.Mode != ModeTranscode || d.ReasonCode != ReasonBitrateExceeds || d.MaxHeightPx != 360 {
		t.Fatalf("bitrate limit: got %s/%s height=%d", d.Mode, d.ReasonCode, d.MaxHeightPx)
	}
}

// Tool availability gates capability advertisement (case 14).
func TestToolsAvailableGatesCapability(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if ok, _ := (Tools{}).Available(ctx); ok {
		t.Fatal("empty tool paths must not report available")
	}
	if ok, _ := (Tools{FFprobePath: "definitely-not-a-real-binary", FFmpegPath: "also-not-real"}).Available(ctx); ok {
		t.Fatal("nonexistent tools must not report available")
	}
	// The planner reflects the same gate: ffmpeg missing → MKV unsupported.
	if d := Plan(PlanInput{Info: mkvH264AAC(), Profile: iosProfile(), FFmpegReady: false}); strings.Contains(d.Message, "magnet") {
		t.Fatal("planner messages must never mention magnets")
	}
}
