package downloads

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"

	"torrent-streamer/internal/config"
)

// A video's own subtitle track is timed to that exact file. Provider
// subtitles are matched by title and release name and can belong to another
// cut: for Dragon Ball Kai the provider file was the English dub's script,
// about 3 s late against a properly timed track inside every episode.

type embeddedSubtitle struct {
	Index  int
	Codec  string
	Lang   string
	Title  string
	Forced bool
	SDH    bool
}

// textSubtitleCodecs are the subtitle codecs ffmpeg can turn into WebVTT;
// picture subtitles (PGS, VobSub) are skipped.
var textSubtitleCodecs = map[string]bool{
	"subrip": true, "srt": true, "ass": true, "ssa": true, "webvtt": true, "mov_text": true, "text": true,
}

// languageAliases maps a requested ISO 639-1 code to the tags containers use.
var languageAliases = map[string][]string{
	"en": {"en", "eng", "english"}, "ja": {"ja", "jpn", "jap", "japanese"},
	"es": {"es", "spa", "esp", "spanish"}, "fr": {"fr", "fre", "fra", "french"},
	"de": {"de", "ger", "deu", "german"}, "it": {"it", "ita", "italian"},
	"pt": {"pt", "por", "portuguese"}, "ru": {"ru", "rus", "russian"},
	"hi": {"hi", "hin", "hindi"}, "ko": {"ko", "kor", "korean"},
	"zh": {"zh", "chi", "zho", "chinese"}, "ar": {"ar", "ara", "arabic"},
}

func subtitleLanguageMatches(tag, lang string) bool {
	tag = strings.ToLower(strings.TrimSpace(tag))
	if tag == "" {
		return false
	}
	for _, alias := range append(languageAliases[lang], lang) {
		if tag == alias {
			return true
		}
	}
	return false
}

// pickEmbeddedSubtitle chooses the full dialogue track for lang: text
// codecs only, never a forced or "signs & songs" track, a non-SDH track
// before an SDH one, then container order.
func pickEmbeddedSubtitle(tracks []embeddedSubtitle, lang string) (embeddedSubtitle, bool) {
	var best embeddedSubtitle
	found := false
	for _, track := range tracks {
		title := strings.ToLower(track.Title)
		if !textSubtitleCodecs[track.Codec] || !subtitleLanguageMatches(track.Lang, lang) || track.Forced ||
			strings.Contains(title, "sign") || strings.Contains(title, "song") || strings.Contains(title, "forced") {
			continue
		}
		if !found || (best.SDH && !track.SDH) {
			best, found = track, true
		}
	}
	return best, found
}

func ffTool(configured, name string) string {
	if configured != "" {
		return configured
	}
	if path, err := exec.LookPath(name); err == nil {
		return path
	}
	return name
}

func probeEmbeddedSubtitles(ctx context.Context, videoPath string) ([]embeddedSubtitle, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, ffTool(config.FFprobePath(), "ffprobe"),
		"-v", "error", "-select_streams", "s",
		"-show_entries", "stream=index,codec_name:stream_tags=language,title:stream_disposition=forced,hearing_impaired",
		"-of", "json", videoPath).Output()
	if err != nil {
		return nil, fmt.Errorf("ffprobe: %w", err)
	}
	var payload struct {
		Streams []struct {
			Index       int               `json:"index"`
			Codec       string            `json:"codec_name"`
			Tags        map[string]string `json:"tags"`
			Disposition map[string]int    `json:"disposition"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(out, &payload); err != nil {
		return nil, err
	}
	tracks := make([]embeddedSubtitle, 0, len(payload.Streams))
	for _, stream := range payload.Streams {
		tracks = append(tracks, embeddedSubtitle{
			Index: stream.Index, Codec: strings.ToLower(stream.Codec),
			Lang: stream.Tags["language"], Title: stream.Tags["title"],
			Forced: stream.Disposition["forced"] == 1, SDH: stream.Disposition["hearing_impaired"] == 1,
		})
	}
	return tracks, nil
}

// extractEmbeddedSubtitle returns the video's own lang track as WebVTT.
func extractEmbeddedSubtitle(ctx context.Context, videoPath, lang string) ([]byte, error) {
	return EmbeddedSubtitleWindow(ctx, videoPath, lang, 0)
}

// EmbeddedSubtitleWindow returns the video's own lang track as WebVTT, read
// from the first seconds of input (a path or URL; 0 reads it all).
func EmbeddedSubtitleWindow(ctx context.Context, videoPath, lang string, seconds int) ([]byte, error) {
	tracks, err := probeEmbeddedSubtitles(ctx, videoPath)
	if err != nil {
		return nil, err
	}
	track, ok := pickEmbeddedSubtitle(tracks, lang)
	if !ok {
		return nil, errors.New("no embedded text subtitle for the language")
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	args := []string{"-nostdin", "-v", "error", "-i", videoPath, "-map", "0:" + strconv.Itoa(track.Index)}
	if seconds > 0 {
		args = append(args, "-t", strconv.Itoa(seconds))
	}
	cmd := exec.CommandContext(ctx, ffTool(config.FFmpegPath(), "ffmpeg"), append(args, "-f", "webvtt", "pipe:1")...)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = io.Discard
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("ffmpeg: %w", err)
	}
	vtt := out.Bytes()
	if !bytes.HasPrefix(bytes.TrimLeft(vtt, "\ufeff \n"), []byte("WEBVTT")) || !bytes.Contains(vtt, []byte("-->")) {
		return nil, errors.New("embedded subtitle produced no cues")
	}
	return vtt, nil
}

// ErrStyledSubtitle reports an ASS/SSA track: its positioned signs and
// styling only survive in the player's own renderer.
var ErrStyledSubtitle = errors.New("styled subtitle track")

// SubtitleTrack is one subtitle stream of a video, in container order.
type SubtitleTrack struct {
	Codec, Lang, Title string
}

// ExtractSubtitleTrack returns the video's ordinal-th subtitle stream
// (container order, as players list them) as WebVTT, so the app can draw a
// torrent's own subtitles exactly like the ones it downloads. Picture
// subtitles cannot be turned into text; styled ones (ASS/SSA) report
// ErrStyledSubtitle. Reads the whole stream (subtitles are interleaved).
func ExtractSubtitleTrack(ctx context.Context, video string, ordinal int) ([]byte, SubtitleTrack, error) {
	tracks, err := probeEmbeddedSubtitles(ctx, video)
	if err != nil {
		return nil, SubtitleTrack{}, err
	}
	if ordinal < 0 || ordinal >= len(tracks) {
		return nil, SubtitleTrack{}, errors.New("no such subtitle track")
	}
	track := tracks[ordinal]
	info := SubtitleTrack{Codec: track.Codec, Lang: track.Lang, Title: track.Title}
	switch {
	case (track.Codec == "ass" || track.Codec == "ssa") && !dialogueOnly(track.Title):
		return nil, info, ErrStyledSubtitle
	case !textSubtitleCodecs[track.Codec]:
		return nil, info, errors.New("picture subtitle track")
	}
	out, err := exec.CommandContext(ctx, ffTool(config.FFmpegPath(), "ffmpeg"),
		"-nostdin", "-v", "error", "-i", video,
		"-map", "0:"+strconv.Itoa(track.Index), "-f", "webvtt", "-").Output()
	if err != nil {
		return nil, info, fmt.Errorf("ffmpeg: %w", err)
	}
	if !bytes.Contains(out, []byte("-->")) {
		return nil, info, errors.New("subtitle track has no cues")
	}
	return out, info, nil
}

// dialogueOnly reports an ASS track that is plain dialogue ("English
// Dubtitles", "Full Subtitles"): drawn as plain text it loses nothing. Signs,
// songs and typeset ("stylized") tracks keep their positioning in the player.
func dialogueOnly(title string) bool {
	return !styledTitle.MatchString(title) && plainTitle.MatchString(title)
}

var (
	// Whole words: "Subtitles" and "Dubtitles" are not "Titles".
	styledTitle = regexp.MustCompile(`(?i)\b(signs?|songs?|stylized|styled|karaoke|titles|typeset|forced)\b`)
	plainTitle  = regexp.MustCompile(`(?i)\b(dub|dubs|dubbed|dubtitles|dialogue|dialog|full|cc|sdh)\b`)
)
