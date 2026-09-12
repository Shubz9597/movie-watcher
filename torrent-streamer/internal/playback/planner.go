package playback

import (
	"fmt"
	"slices"
	"strings"
)

// PlanInput is everything the planner needs. It is deliberately free of
// transport details (no URLs, no magnets, no paths).
type PlanInput struct {
	Info        *MediaInfo
	Profile     CapabilityProfile
	FFmpegReady bool // false when the FFmpeg executable is not configured/verified
	// MaxTranscodeHeight bounds every transcode plan (server-side policy,
	// never a device claim). 0 = default 1080.
	MaxTranscodeHeight int
}

// Plan decides direct / remux / transcode / unsupported.
//
// Decision table (versioned with the API contract):
//
//	inspection failure / no video        -> unsupported (media_inspection_failed | malformed_source)
//	container in profile AND codecs ok
//	  AND resolution/bitrate within profile AND (HDR ok)
//	                                     -> direct
//	codecs compatible but container not  -> remux   (requires FFmpeg)
//	codec incompatible                   -> transcode (requires FFmpeg)
//	HDR and profile denies HDR           -> transcode (tonemap bounded) or unsupported
//	FFmpeg required but missing          -> unsupported (ffmpeg_missing)
func Plan(in PlanInput) Decision {
	if in.Info == nil {
		return unsupported(ReasonMediaInspectionFail, "The media could not be inspected.")
	}
	if in.Info.Video.Codec == "" {
		return unsupported(ReasonMalformedSource, "The selected file does not contain a video stream this server can plan for.")
	}
	if err := validateDimensions(in.Info); err != nil {
		return unsupported(ReasonMalformedSource, err.Error())
	}

	videoOK := containsFold(in.Profile.VideoCodecs, in.Info.Video.Codec)
	audioOK := containsFold(in.Profile.AudioCodecs, in.Info.Audio.Codec) || in.Info.Audio.Codec == ""
	containerOK := containsFold(in.Profile.Containers, normalizeContainer(in.Info.Container))
	resOK := in.Profile.MaxHeightPx <= 0 || in.Info.Height <= in.Profile.MaxHeightPx
	bitrateOK := in.Profile.MaxBitrateBps <= 0 || in.Info.BitrateBps <= in.Profile.MaxBitrateBps
	hdrOK := in.Info.HDR == "" || in.Profile.HDR

	if containerOK && videoOK && audioOK && resOK && bitrateOK && hdrOK {
		return Decision{Mode: ModeDirect, ReasonCode: ReasonCompatible, Message: "Plays directly without any conversion."}
	}

	if !in.FFmpegReady {
		return unsupported(ReasonFFmpegMissing,
			"The server cannot convert this source: FFmpeg is not configured. Direct-playing sources still work.")
	}

	if !videoOK {
		return Decision{
			Mode: ModeTranscode, ReasonCode: ReasonVideoCodecIncompat, CopyVideo: false, CopyAudio: audioOK,
			MaxHeightPx: transcodeHeight(in),
			Message:     fmt.Sprintf("The video codec (%s) is not supported on this device; the server will convert it to H.264.", in.Info.Video.Codec),
		}
	}
	if !hdrOK {
		// The current FFmpeg runner has no verified HDR-to-SDR tone-map filter.
		// Encoding HDR frames as ordinary H.264 would start successfully but
		// produce materially wrong colours, so fail truthfully instead.
		return unsupported(ReasonHDRUnsupported,
			"This device profile cannot play HDR and server-side tone mapping is not available yet.")
	}
	if !resOK {
		return Decision{
			Mode: ModeTranscode, ReasonCode: ReasonResolutionExceeds, CopyVideo: false, CopyAudio: audioOK,
			MaxHeightPx: transcodeHeight(in),
			Message:     "The source resolution exceeds this device profile; the server will convert it to a bounded H.264 rendition.",
		}
	}
	if !bitrateOK {
		return Decision{
			Mode: ModeTranscode, ReasonCode: ReasonBitrateExceeds, CopyVideo: false, CopyAudio: audioOK,
			MaxHeightPx: transcodeHeight(in),
			Message:     "The source bitrate exceeds this device profile; the server will convert it to a bounded H.264 rendition.",
		}
	}
	if !audioOK {
		// Video copies; only audio is converted.
		return Decision{
			Mode: ModeRemux, ReasonCode: ReasonAudioCodecIncompat, CopyVideo: true, CopyAudio: false,
			Message: fmt.Sprintf("The container and video are compatible; only the audio codec (%s) will be converted.", in.Info.Audio.Codec),
		}
	}
	// Container is the only problem (e.g. MKV with H.264/AAC) — stream copy.
	return Decision{
		Mode: ModeRemux, ReasonCode: ReasonContainerIncompatible, CopyVideo: true, CopyAudio: true,
		Message: "The video and audio are compatible; the container will be remuxed for streaming.",
	}
}

func validateDimensions(info *MediaInfo) error {
	if info.Width < 0 || info.Height < 0 || info.Width > 100000 || info.Height > 100000 {
		return fmt.Errorf("implausible media dimensions")
	}
	if info.DurationSec < 0 || info.DurationSec > 24*3600*7 {
		return fmt.Errorf("implausible media duration")
	}
	return nil
}

func transcodeHeight(in PlanInput) int {
	max := in.MaxTranscodeHeight
	if max <= 0 {
		max = 1080
	}
	if in.Profile.MaxHeightPx > 0 && in.Profile.MaxHeightPx < max {
		max = in.Profile.MaxHeightPx
	}
	height := in.Info.Height
	if height <= 0 || height > max {
		return max
	}
	return height
}

func unsupported(code, message string) Decision {
	return Decision{Mode: ModeUnsupported, ReasonCode: code, Message: message}
}

func containsFold(values []string, want string) bool {
	if want == "" {
		return false
	}
	return slices.ContainsFunc(values, func(v string) bool { return strings.EqualFold(v, want) })
}

func normalizeContainer(container string) string {
	c := strings.ToLower(strings.TrimSpace(container))
	// ffprobe reports comma-separated format names; pick the most specific
	// family so "mov,mp4,m4a,3gp,3g2,mj2" maps to "mp4".
	switch {
	case c == "":
		return ""
	case strings.Contains(c, "mp4"), strings.Contains(c, "mov"), strings.Contains(c, "m4v"):
		return "mp4"
	case strings.Contains(c, "matroska"), strings.Contains(c, "mkv"), strings.Contains(c, "webm"):
		// webm is technically matroska; keep it distinct for profiles.
		if strings.Contains(c, "webm") {
			return "webm"
		}
		return "mkv"
	case strings.Contains(c, "avi"):
		return "avi"
	case strings.Contains(c, "mpegts"), strings.Contains(c, "mpeg"):
		return "mpegts"
	default:
		return c
	}
}
