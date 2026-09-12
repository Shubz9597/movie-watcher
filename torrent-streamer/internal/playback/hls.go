package playback

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// MIME types for HLS/fMP4 delivery (correct for AVPlayer and Media3).
const (
	MIMEPlaylist = "application/vnd.apple.mpegurl"
	MIMESegment  = "video/mp4" // fMP4 (CMAF) segments
	MIMESubtitle = "text/vtt; charset=utf-8"
)

// WriteMasterPlaylist renders the session's master playlist. Direct sessions
// never get a playlist (they use the media endpoint). Subtitle renditions are
// declared as an EXT-X-MEDIA SUBTITLES group; every referenced file was
// produced and validated by the subtitle collector before being listed.
func WriteMasterPlaylist(sess *session) string {
	var b strings.Builder
	b.WriteString("#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n")
	if len(sess.view.Subtitles) > 0 {
		for i, sub := range sess.view.Subtitles {
			fmt.Fprintf(&b, "#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\",NAME=\"%s\",LANGUAGE=\"%s\",DEFAULT=%s,FORCED=%s,AUTOSELECT=YES,URI=\"subtitles/%s.vtt\"\n",
				playlistEscape(nonEmpty(sub.Label, sub.Language, fmt.Sprintf("Track %d", i+1))),
				playlistEscape(nonEmpty(sub.Language, "und")),
				yesNo(sub.Default), yesNo(sub.Forced), sub.ID)
		}
	}
	// The variant playlist is the one FFmpeg produced inside the session dir.
	// Advertise the OUTPUT rendition, not the inspected source: a transcode is
	// H.264/AAC even when its input was VP9/Opus, and may be scaled down.
	fmt.Fprintf(&b, "#EXT-X-STREAM-INF:BANDWIDTH=%d", playlistBandwidth(sess.view.Info))
	if codecs := playlistCodecs(sess.view.Info, sess.decision); codecs != "" {
		fmt.Fprintf(&b, ",CODECS=\"%s\"", codecs)
	}
	if width, height := playlistResolution(sess.view.Info, sess.decision); width > 0 && height > 0 {
		fmt.Fprintf(&b, ",RESOLUTION=%dx%d", width, height)
	}
	if len(sess.view.Subtitles) > 0 {
		b.WriteString(",SUBTITLES=\"subs\"")
	}
	b.WriteString("\nhls/playlist.m3u8\n")
	return b.String()
}

func playlistBandwidth(info *MediaInfo) int64 {
	if info == nil || info.BitrateBps <= 0 {
		return 2000000
	}
	return info.BitrateBps
}

func playlistCodecs(info *MediaInfo, decision Decision) string {
	if info == nil {
		return ""
	}
	var codecs []string
	video := info.Video
	if !decision.CopyVideo {
		video = VideoInfo{Codec: "h264"}
	}
	if c := rfc6381VideoCodec(video); c != "" {
		codecs = append(codecs, c)
	}
	audioCodec := info.Audio.Codec
	if !decision.CopyAudio && audioCodec != "" {
		audioCodec = "aac"
	}
	if audioCodec != "" {
		switch strings.ToLower(audioCodec) {
		case "aac":
			codecs = append(codecs, "mp4a.40.2")
		case "mp3":
			codecs = append(codecs, "mp4a.6.1")
		case "opus":
			codecs = append(codecs, "opus")
		default:
			codecs = append(codecs, strings.ToLower(info.Audio.Codec))
		}
	}
	return strings.Join(codecs, ",")
}

func playlistResolution(info *MediaInfo, decision Decision) (int, int) {
	if info == nil || info.Width <= 0 || info.Height <= 0 {
		return 0, 0
	}
	if decision.CopyVideo || decision.MaxHeightPx <= 0 || info.Height <= decision.MaxHeightPx {
		return info.Width, info.Height
	}
	height := decision.MaxHeightPx
	// FFmpeg's scale=-2 keeps aspect ratio and rounds to an even width.
	width := ((info.Width*height/info.Height + 1) / 2) * 2
	return width, height
}

func rfc6381VideoCodec(v VideoInfo) string {
	switch strings.ToLower(v.Codec) {
	case "h264":
		return "avc1.640028" // High Profile L4.0 baseline declaration for compatibility
	case "hevc", "hvc1":
		return "hvc1.1.6.L120.90"
	default:
		return strings.ToLower(v.Codec)
	}
}

func playlistEscape(value string) string {
	return strings.NewReplacer("\"", "", ",", "", "\n", "", "\r", "").Replace(value)
}

func yesNo(b bool) string {
	if b {
		return "YES"
	}
	return "NO"
}

// ServeSessionFile serves a file inside a session directory (HLS segments,
// the variant playlist, subtitles). Path traversal is refused: the requested
// relative path is resolved and MUST remain inside that session's directory.
func ServeSessionFile(w http.ResponseWriter, r *http.Request, root, sessionID, relativePath, contentType string) bool {
	if sessionID == "" || relativePath == "" {
		http.NotFound(w, r)
		return false
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		http.NotFound(w, r)
		return false
	}
	sessionDir, err := safeJoin(rootAbs, sessionID)
	if err != nil {
		http.NotFound(w, r)
		return false
	}
	target, err := safeJoin(sessionDir, relativePath)
	if err != nil {
		http.NotFound(w, r)
		return false
	}
	file, err := os.Open(target)
	if err != nil {
		http.NotFound(w, r)
		return false
	}
	defer file.Close()
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "no-store")
	var modTime time.Time
	if info, statErr := file.Stat(); statErr == nil {
		modTime = info.ModTime()
	}
	http.ServeContent(w, r, filepath.Base(target), modTime, file)
	return true
}
