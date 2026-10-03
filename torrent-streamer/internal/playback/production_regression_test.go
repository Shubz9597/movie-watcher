package playback

import (
	"testing"
)

func TestRegressionIncompatibleHDRPlan(t *testing.T) {
	d := Plan(PlanInput{Info: &MediaInfo{Container: "mkv", Video: VideoInfo{Codec: "av1"}, Audio: AudioInfo{Codec: "aac"}, HDR: "hdr10", Height: 2160, Width: 3840}, Profile: DefaultProfiles()["android-media3"], FFmpegReady: true, TranscodeAllowed: true})
	if d.Mode != ModeUnsupported || d.ReasonCode != ReasonHDRUnsupported {
		t.Errorf("AV1 HDR on SDR profile got %s/%s, want unsupported HDR because runner has no tone mapping", d.Mode, d.ReasonCode)
	}
}
