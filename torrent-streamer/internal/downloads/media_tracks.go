package downloads

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"torrent-streamer/internal/config"
)

// MediaTrack is one of a video's own audio or subtitle streams.
type MediaTrack struct {
	Language string `json:"language,omitempty"`
	Title    string `json:"title,omitempty"`
	Codec    string `json:"codec"`
	Channels int    `json:"channels,omitempty"`
	Default  bool   `json:"default,omitempty"`
	Forced   bool   `json:"forced,omitempty"`
	// CC: captions for the hearing impaired (speaker names and sounds).
	CC bool `json:"cc,omitempty"`
}

// MediaTracks lists a video's audio and subtitle streams, each in container
// order: the order players number them (mpv's aid/sid 1, 2, …), so the
// desktop can name its player's tracks the way the phone does.
type MediaTracks struct {
	Audio     []MediaTrack `json:"audio"`
	Subtitles []MediaTrack `json:"subtitles"`
}

// ProbeMediaTracks reads the track list from the video's header (a torrent
// read through /stream: the first answer can take a while).
func ProbeMediaTracks(ctx context.Context, video string, limit time.Duration) (MediaTracks, error) {
	ctx, cancel := context.WithTimeout(ctx, limit)
	defer cancel()
	out, err := exec.CommandContext(ctx, ffTool(config.FFprobePath(), "ffprobe"),
		"-v", "error",
		"-show_entries", "stream=index,codec_type,codec_name,channels:stream_tags=language,title:stream_disposition=default,forced,hearing_impaired",
		"-of", "json", video).Output()
	if err != nil {
		return MediaTracks{}, fmt.Errorf("ffprobe: %w", err)
	}
	return parseMediaTracks(out)
}

func parseMediaTracks(out []byte) (MediaTracks, error) {
	var payload struct {
		Streams []struct {
			Type        string            `json:"codec_type"`
			Codec       string            `json:"codec_name"`
			Channels    int               `json:"channels"`
			Tags        map[string]string `json:"tags"`
			Disposition map[string]int    `json:"disposition"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(out, &payload); err != nil {
		return MediaTracks{}, err
	}
	tracks := MediaTracks{Audio: []MediaTrack{}, Subtitles: []MediaTrack{}}
	for _, stream := range payload.Streams {
		tag := func(name string) string {
			for key, value := range stream.Tags {
				if strings.EqualFold(key, name) {
					return strings.TrimSpace(value)
				}
			}
			return ""
		}
		track := MediaTrack{
			Language: tag("language"), Title: tag("title"), Codec: strings.ToLower(stream.Codec),
			Default: stream.Disposition["default"] == 1, Forced: stream.Disposition["forced"] == 1,
			CC: stream.Disposition["hearing_impaired"] == 1,
		}
		if strings.EqualFold(track.Language, "und") {
			track.Language = ""
		}
		switch stream.Type {
		case "audio":
			track.Channels = stream.Channels
			tracks.Audio = append(tracks.Audio, track)
		case "subtitle":
			tracks.Subtitles = append(tracks.Subtitles, track)
		}
	}
	return tracks, nil
}
