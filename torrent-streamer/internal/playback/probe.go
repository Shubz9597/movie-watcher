package playback

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// MediaInfo is the inspection summary returned to clients. It must never
// contain local filesystem paths, magnet URIs, or credential material.
type MediaInfo struct {
	Container    string          `json:"container"`
	DurationSec  float64         `json:"durationSec"`
	Width        int             `json:"width"`
	Height       int             `json:"height"`
	Video        VideoInfo       `json:"video"`
	Audio        AudioInfo       `json:"audio"`
	BitrateBps   int64           `json:"bitrateBps"`
	HDR          string          `json:"hdr,omitempty"` // e.g. "hdr10", "dolbyvision" when detectable
	SubtitleWire []SubtitleTrack `json:"subtitleTracks"`
	// FileIndex is the selected torrent file index (client-supplied, echoed).
	FileIndex int `json:"fileIndex"`
}

type VideoInfo struct {
	Codec    string `json:"codec"`
	Profile  string `json:"profile,omitempty"`
	Level    string `json:"level,omitempty"`
	BitDepth int    `json:"bitDepth,omitempty"`
	PixelFmt string `json:"pixelFormat,omitempty"`
}

type AudioInfo struct {
	Codec    string `json:"codec"`
	Channels int    `json:"channels,omitempty"`
}

// SubtitleTrack describes one embedded (or attached) subtitle track.
type SubtitleTrack struct {
	Index    int    `json:"index"`
	Format   string `json:"format"` // srt, ass, ssa, vtt, pgs (hdmv_pgs_subtitle), mov_text
	Language string `json:"language,omitempty"`
	Label    string `json:"label,omitempty"`
	Default  bool   `json:"default,omitempty"`
	Forced   bool   `json:"forced,omitempty"`
}

// Prober inspects media at a URL. The URL is opaque to implementers (the
// production implementation receives the loopback token URL; tests may use
// file or data URLs). Hiding exec behind this interface keeps the decision
// logic testable without FFmpeg installed.
type Prober interface {
	Probe(ctx context.Context, mediaURL string) (*MediaInfo, error)
}

// Tools reports the configured external executables.
type Tools struct {
	FFprobePath string
	FFmpegPath  string
}

// Available verifies BOTH tools can be executed and reports a human-safe
// description. This gates capability advertisement.
func (t Tools) Available(ctx context.Context) (bool, string) {
	for _, tool := range []struct{ name, path string }{
		{"ffprobe", t.FFprobePath},
		{"ffmpeg", t.FFmpegPath},
	} {
		if tool.path == "" {
			return false, tool.name + " not configured"
		}
		ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		out, err := exec.CommandContext(ctx, tool.path, "-version").Output()
		if err != nil {
			return false, tool.name + " not executable"
		}
		if !strings.Contains(string(out), tool.name) {
			return false, tool.name + " did not identify itself"
		}
	}
	return true, ""
}

// FFprobeProber implements Prober via the ffprobe executable.
type FFprobeProber struct {
	Tools
	Timeout time.Duration
}

// Compile-time interface checks.
var (
	_ Prober = (*FFprobeProber)(nil)
)

// Probe runs ffprobe with argument arrays ONLY (never a shell string) and a
// bounded, cancellable context.
func (p *FFprobeProber) Probe(ctx context.Context, mediaURL string) (*MediaInfo, error) {
	if mediaURL == "" {
		return nil, fmt.Errorf("%s: empty media URL", ReasonMediaInspectionFail)
	}
	timeout := p.Timeout
	if timeout <= 0 {
		timeout = 20 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	// Argument arrays only. mediaURL is passed as one argument; the loopback
	// URL contains an opaque token, never a magnet.
	args := []string{
		"-v", "error",
		"-print_format", "json",
		"-show_format", "-show_streams",
		"-analyzeduration", "10M", "-probesize", "50M",
		mediaURL,
	}
	cmd := exec.CommandContext(ctx, p.FFprobePath, args...)
	out, err := cmd.Output()
	if err != nil {
		// Never include the URL (token) or any stderr echo of it.
		return nil, fmt.Errorf("%s: ffprobe failed", ReasonMediaInspectionFail)
	}
	info, parseErr := parseFFprobeJSON(out)
	if parseErr != nil {
		return nil, fmt.Errorf("%s: %v", ReasonMalformedSource, parseErr)
	}
	return info, nil
}

type ffprobeOutput struct {
	Format struct {
		FormatName string `json:"format_name"`
		Duration   string `json:"duration"`
		BitRate    string `json:"bit_rate"`
	} `json:"format"`
	Streams []struct {
		Index     int    `json:"index"`
		Type      string `json:"codec_type"`
		CodecName string `json:"codec_name"`
		Profile   string `json:"profile"`
		Level     int    `json:"level"`
		Width     int    `json:"width"`
		Height    int    `json:"height"`
		PixFmt    string `json:"pix_fmt"`
		Channels  int    `json:"channels"`
		Duration  string `json:"duration"`
		BitRate   string `json:"bit_rate"`
		Tags      struct {
			Language      string `json:"language"`
			Title         string `json:"title"`
			HDR10         string `json:"hdr10"` // ffprobe side data surfaces vary; parsed best-effort
			ColorTransfer string `json:"color_transfer"`
		} `json:"tags"`
		Disposition struct {
			Default int `json:"default"`
			Forced  int `json:"forced"`
		} `json:"disposition"`
	} `json:"streams"`
}

func parseFFprobeJSON(data []byte) (*MediaInfo, error) {
	var parsed ffprobeOutput
	if err := json.Unmarshal(data, &parsed); err != nil {
		return nil, err
	}
	info := &MediaInfo{Container: strings.Split(parsed.Format.FormatName, ",")[0]}
	if d, err := strconv.ParseFloat(parsed.Format.Duration, 64); err == nil {
		info.DurationSec = d
	}
	if b, err := strconv.ParseInt(parsed.Format.BitRate, 10, 64); err == nil {
		info.BitrateBps = b
	}
	for _, s := range parsed.Streams {
		switch s.Type {
		case "video":
			if info.Video.Codec == "" {
				info.Video = VideoInfo{
					Codec:    s.CodecName,
					Profile:  s.Profile,
					BitDepth: bitDepthFromPixFmt(s.PixFmt),
					PixelFmt: s.PixFmt,
				}
				if s.Level > 0 {
					info.Video.Level = strconv.Itoa(s.Level)
				}
				info.Width, info.Height = s.Width, s.Height
				info.HDR = hdrFromPixFmtAndTransfer(s.PixFmt, s.Tags.ColorTransfer)
			}
		case "audio":
			if info.Audio.Codec == "" {
				info.Audio = AudioInfo{Codec: s.CodecName, Channels: s.Channels}
			}
		case "subtitle":
			format := normalizeSubtitleCodec(s.CodecName)
			info.SubtitleWire = append(info.SubtitleWire, SubtitleTrack{
				Index:    s.Index,
				Format:   format,
				Language: s.Tags.Language,
				Label:    s.Tags.Title,
				Default:  s.Disposition.Default == 1,
				Forced:   s.Disposition.Forced == 1,
			})
		}
	}
	if info.Video.Codec == "" {
		return nil, fmt.Errorf("no video stream found")
	}
	return info, nil
}

func normalizeSubtitleCodec(codec string) string {
	switch codec {
	case "subrip":
		return "srt"
	case "hdmv_pgs_subtitle":
		return "pgs"
	case "mov_text":
		return "mov_text"
	case "ass":
		return "ass"
	case "ssa":
		return "ssa"
	case "webvtt":
		return "vtt"
	default:
		return codec
	}
}

func bitDepthFromPixFmt(pixFmt string) int {
	switch {
	case strings.Contains(pixFmt, "10"):
		return 10
	case strings.Contains(pixFmt, "12"):
		return 12
	case strings.Contains(pixFmt, "16"):
		return 16
	default:
		return 8
	}
}

func hdrFromPixFmtAndTransfer(pixFmt, transfer string) string {
	t := strings.ToLower(transfer)
	switch {
	case strings.Contains(t, "smpte2084"):
		return "hdr10"
	case strings.Contains(t, "arib-std-b67"):
		return "hlg"
	case strings.Contains(pixFmt, "yuv420p10") && t != "":
		return "hdr"
	default:
		return ""
	}
}
