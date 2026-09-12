// Package playback implements the shared mobile playback compatibility
// service (feature 002 M1.3.2–M1.3.8): media inspection, playback planning,
// HLS/fMP4 remux/transcode, subtitle normalization, and the session lifecycle
// used by BOTH future native clients (iOS AVPlayer, Android Media3) through
// one versioned contract.
//
// Security invariants enforced in this package:
//   - Session and source identifiers are cryptographically random and opaque.
//   - Magnet URIs NEVER appear in FFmpeg/ffprobe command lines (a loopback
//     token-authenticated internal media source is used instead), in
//     playlists, segment URLs, error responses, or logs.
//   - Local filesystem paths never appear in API responses.
//   - All process execution uses argument arrays (no shell strings).
//   - Cleanup is constrained to the configured playback-session data root.
package playback

import "time"

// Mode is the playback decision for a session.
type Mode string

const (
	ModeDirect      Mode = "direct"
	ModeRemux       Mode = "remux"
	ModeTranscode   Mode = "transcode"
	ModeUnsupported Mode = "unsupported"
)

// CapabilityProfile describes what a client class can consume. Profiles are
// shared contract data, NOT per-platform business logic: handlers never
// hard-code platform names.
type CapabilityProfile struct {
	// Name is the profile identifier clients advertise ("ios-avplayer",
	// "android-media3").
	Name string `json:"name"`
	// Containers lists acceptable DIRECT playback containers (fMP4 family).
	Containers []string `json:"containers"`
	// VideoCodecs lists acceptable direct-play video codecs.
	VideoCodecs []string `json:"videoCodecs"`
	// AudioCodecs lists acceptable direct-play audio codecs.
	AudioCodecs []string `json:"audioCodecs"`
	// MaxHeightPx bounds the video height the device accepts directly.
	MaxHeightPx int `json:"maxHeightPx"`
	// MaxBitrateBps bounds the total bitrate the device accepts directly
	// (0 = no configured bound; the server may still apply its own).
	MaxBitrateBps int64 `json:"maxBitrateBps"`
	// HLSfMP4 reports whether the client accepts HLS with fMP4/CMAF
	// segments (the common compatibility transport).
	HLSfMP4 bool `json:"hlsFmp4"`
	// HDR reports whether the client accepts HDR variants directly.
	HDR bool `json:"hdr"`
	// SubtitleFormats lists client-acceptable subtitle deliveries.
	SubtitleFormats []string `json:"subtitleFormats"`
}

// Reason codes are stable contract values (versioned with the API).
const (
	ReasonCompatible            = "compatible"
	ReasonContainerIncompatible = "container_incompatible"
	ReasonVideoCodecIncompat    = "video_codec_incompatible"
	ReasonAudioCodecIncompat    = "audio_codec_incompatible"
	ReasonResolutionExceeds     = "resolution_exceeds_profile"
	ReasonBitrateExceeds        = "bitrate_exceeds_profile"
	ReasonHDRUnsupported        = "hdr_unsupported"
	ReasonFFmpegMissing         = "ffmpeg_missing"
	ReasonFFprobeMissing        = "ffprobe_missing"
	ReasonMediaInspectionFail   = "media_inspection_failed"
	ReasonMalformedSource       = "malformed_source"
	ReasonSubtitleUnsupported   = "subtitle_unsupported"
	ReasonCapacityExhausted     = "transcode_capacity_exhausted"
	ReasonSessionLimit          = "session_limit_exceeded"
)

// Decision is the outcome of planning for one inspected source.
type Decision struct {
	Mode       Mode
	ReasonCode string
	Message    string // human-safe, machine-filtered (no magnets/paths)
	// CopyVideo/CopyAudio are meaningful for remux/transcode plans.
	CopyVideo bool
	CopyAudio bool
	// MaxHeightPx is the bounded output height for a transcode plan.
	MaxHeightPx int
}

// DefaultProfiles returns the two initial shared profiles. The initial safe
// shared output across both is H.264/AAC HLS + WebVTT; the differences below
// reflect well-documented platform baselines and may be refined later WITHOUT
// changing the session lifecycle.
func DefaultProfiles() map[string]CapabilityProfile {
	ios := CapabilityProfile{
		Name:            "ios-avplayer",
		Containers:      []string{"mp4", "mov", "m4v"},
		VideoCodecs:     []string{"h264", "hevc"},
		AudioCodecs:     []string{"aac", "alac", "mp3"},
		MaxHeightPx:     2160,
		MaxBitrateBps:   0,
		HLSfMP4:         true,
		HDR:             true, // Dolby Vision/HDR10 on modern hardware; planner still bounds HEVC+HDR decisions
		SubtitleFormats: []string{"vtt"},
	}
	android := CapabilityProfile{
		Name:            "android-media3",
		Containers:      []string{"mp4", "webm", "m4v"},
		VideoCodecs:     []string{"h264", "hevc", "vp9"},
		AudioCodecs:     []string{"aac", "opus", "mp3", "vorbis"},
		MaxHeightPx:     2160,
		MaxBitrateBps:   0,
		HLSfMP4:         true,
		HDR:             false, // conservative baseline; HDR10 via Media3 is a later optimization
		SubtitleFormats: []string{"vtt"},
	}
	return map[string]CapabilityProfile{
		ios.Name:     ios,
		android.Name: android,
	}
}

// SessionDefaults are the bounded operational defaults; each is overridable
// by configuration at the wiring layer.
type SessionDefaults struct {
	MaxActiveTranscodes int
	SessionTTL          time.Duration
	ProbeTimeout        time.Duration
	MaxTranscodeHeight  int
}
