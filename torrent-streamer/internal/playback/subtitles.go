package playback

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"torrent-streamer/internal/subtitles"
)

// MaxSubtitleBytes bounds any sidecar/extracted subtitle read (4 MiB — far
// above any legitimate text subtitle).
const MaxSubtitleBytes = 4 << 20

// collectSubtitles prepares the session's WebVTT offers:
//   - embedded sidecar files (SRT/VTT pure-Go; ASS/SSA via ffmpeg with
//     documented styling loss) for the SELECTED video only,
//   - container-internal text streams (remux/transcode sessions) via ffmpeg
//     extraction when FFmpeg is ready.
//
// A track is offered ONLY when its WebVTT output was actually produced and
// syntactically valid (never a claimed-but-missing track). PGS/image formats
// are returned as unsupported (documented limitation) — they simply produce
// no offer here.
func (m *Manager) collectSubtitles(ctx context.Context, sess *session, resolved ResolvedSource, info *MediaInfo, srcURL string) []SubtitleOffer {
	offers := make([]SubtitleOffer, 0, len(resolved.Sidecars)+len(info.SubtitleWire))
	trackID := 0
	ffmpegPath := m.tools.FFmpegPath

	for _, sidecar := range resolved.Sidecars {
		// VLC reads original sidecars directly, including ASS styling. Never
		// start FFmpeg just to normalize subtitles on a direct-play session.
		format := strings.ToLower(sidecar.Format)
		profile := DefaultProfiles()[sess.view.Profile]
		if !sess.hls && strings.HasSuffix(profile.Name, "-vlc") && containsFold(profile.SubtitleFormats, format) {
			data, ok := readBounded(sidecar.Open)
			if !ok || len(data) == 0 {
				continue
			}
			id := fmt.Sprintf("t%d", trackID)
			trackID++
			name := id + "." + format
			if err := os.WriteFile(filepath.Join(sess.dir, name), data, 0o644); err != nil {
				continue
			}
			offers = append(offers, SubtitleOffer{
				ID: id, Language: sidecar.Language,
				Label:  nonEmpty(sidecar.Label, sidecar.Language, "Subtitle"),
				URL:    "/v2/playback/sessions/" + sess.id + "/subtitles/" + name,
				Origin: "embedded-sidecar",
			})
			continue
		}
		vtt, ok := sidecarToVTT(ctx, sess.runner, ffmpegPath, srcURL, sidecar)
		if !ok {
			continue // truthfully absent, never claimed
		}
		id := fmt.Sprintf("t%d", trackID)
		trackID++
		file := filepath.Join(sess.dir, id+".vtt")
		if err := os.WriteFile(file, []byte(vtt), 0o644); err != nil {
			continue
		}
		if !validWebVTTFile(file) {
			_ = os.Remove(file)
			continue
		}
		offers = append(offers, SubtitleOffer{
			ID:       id,
			Language: sidecar.Language,
			Label:    nonEmpty(sidecar.Label, sidecar.Language, "Subtitle"),
			URL:      "/v2/playback/sessions/" + sess.id + "/subtitles/" + id + ".vtt",
			Origin:   "embedded-sidecar",
		})
	}

	// Container-internal text subtitle streams (text formats only; PGS and
	// other image formats are unsupported by design for HLS/WebVTT delivery).
	if sess.hls && m.tools.FFmpegPath != "" {
		for _, track := range info.SubtitleWire {
			if !isTextSubtitle(track.Format) {
				continue
			}
			id := fmt.Sprintf("t%d", trackID)
			trackID++
			file := filepath.Join(sess.dir, id+".vtt")
			if err := sess.runner.ExtractSubtitle(ctx, srcURL, track.Index, file); err != nil {
				continue
			}
			if !validWebVTTFile(file) {
				_ = os.Remove(file)
				continue
			}
			offers = append(offers, SubtitleOffer{
				ID:       id,
				Language: nonEmpty(track.Language, "und"),
				Label:    nonEmpty(track.Label, track.Language, "Subtitle"),
				Default:  track.Default,
				Forced:   track.Forced,
				URL:      "/v2/playback/sessions/" + sess.id + "/subtitles/" + id + ".vtt",
				Origin:   "container-stream",
			})
		}
	}
	return offers
}

// sidecarToVTT converts one sidecar to WebVTT text.
func sidecarToVTT(ctx context.Context, runner sessionRunner, ffmpegPath string, srcURL string, sidecar Sidecar) (string, bool) {
	switch strings.ToLower(sidecar.Format) {
	case "vtt":
		data, ok := readBounded(sidecar.Open)
		if !ok {
			return "", false
		}
		return string(data), validWebVTT(string(data))
	case "srt":
		data, ok := readBounded(sidecar.Open)
		if !ok {
			return "", false
		}
		vtt := subtitles.SRTtoVTT(string(data))
		return vtt, validWebVTT(vtt)
	case "ass", "ssa":
		// ASS/SSA → WebVTT via ffmpeg; styling is intentionally dropped
		// (documented limitation of the shared VTT contract).
		if runner == nil || ffmpegPath == "" {
			return "", false
		}
		// ffmpeg needs a seekable input for ASS; the loopback source works.
		// Write through a temp file inside the caller's session dir is done
		// by the caller via ExtractSubtitle only for container streams; for
		// sidecar files we convert the BYTES via stdin instead.
		data, ok := readBounded(sidecar.Open)
		if !ok {
			return "", false
		}
		return convertAssToVTT(ctx, ffmpegPath, data)
	default:
		return "", false
	}
}

func readBounded(open func() (io.ReadCloser, error)) ([]byte, bool) {
	rc, err := open()
	if err != nil {
		return nil, false
	}
	defer rc.Close()
	data, err := io.ReadAll(io.LimitReader(rc, MaxSubtitleBytes+1))
	if err != nil || len(data) > MaxSubtitleBytes {
		return nil, false
	}
	return data, true
}

func isTextSubtitle(format string) bool {
	switch strings.ToLower(format) {
	case "srt", "ass", "ssa", "vtt", "mov_text", "text":
		return true
	default:
		return false
	}
}

var vttHeaderRe = regexp.MustCompile("(?s)^(?:\uFEFF)?WEBVTT\\b")

// validWebVTT performs the minimal syntactic validity gate: a WEBVTT header
// line (with optional BOM) and no SRT-style comma timestamps left behind.
func validWebVTT(vtt string) bool {
	if !vttHeaderRe.MatchString(vtt) {
		return false
	}
	return !regexp.MustCompile(`\d{2}:\d{2}:\d{2},\d{3}`).MatchString(vtt)
}

func validWebVTTFile(path string) bool {
	data, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	return validWebVTT(string(data))
}

func nonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// convertAssToVTT converts ASS/SSA bytes to WebVTT via ffmpeg stdin/stdout
// (argument arrays only; bounded; no shell). Styling loss is documented.
func convertAssToVTT(ctx context.Context, ffmpegPath string, assData []byte) (string, bool) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, ffmpegPath,
		"-nostdin", "-loglevel", "error",
		"-f", "ass", "-i", "pipe:0",
		"-f", "webvtt", "pipe:1",
	)
	cmd.Stdin = bytes.NewReader(assData)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = io.Discard
	if err := cmd.Run(); err != nil {
		return "", false
	}
	vtt := out.String()
	return vtt, validWebVTT(vtt)
}
