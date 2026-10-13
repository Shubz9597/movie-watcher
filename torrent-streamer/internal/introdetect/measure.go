package introdetect

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"strings"
)

// maxTracks bounds the audio tracks fingerprinted per file (a dub and the
// original; a dual-audio release's English opening can differ from the
// Japanese one, as Dragon Ball Z Kai's early episodes do).
const maxTracks = 3

// Probe returns the number of audio tracks and the duration of input (a
// path or URL).
func Probe(ctx context.Context, ffprobe, input string) (tracks int, duration float64, err error) {
	out, err := exec.CommandContext(ctx, ffprobe, "-v", "error", "-show_entries", "format=duration:stream=codec_type",
		"-of", "json", input).Output()
	if err != nil {
		return 0, 0, fmt.Errorf("ffprobe: %w", err)
	}
	var payload struct {
		Streams []struct {
			CodecType string `json:"codec_type"`
		} `json:"streams"`
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
	}
	if err := json.Unmarshal(out, &payload); err != nil {
		return 0, 0, err
	}
	for _, s := range payload.Streams {
		if s.CodecType == "audio" {
			tracks++
		}
	}
	duration, _ = strconv.ParseFloat(strings.TrimSpace(payload.Format.Duration), 64)
	return tracks, duration, nil
}

// Measure fingerprints both ends of every audio track of input: the first
// profile.HeadSeconds and the last profile.TailSeconds.
func Measure(ctx context.Context, ffmpeg, ffprobe, input string, profile Profile) (head, tail []Part, duration float64, err error) {
	tracks, duration, err := Probe(ctx, ffprobe, input)
	if err != nil {
		return nil, nil, 0, err
	}
	if tracks == 0 || duration <= 0 {
		return nil, nil, 0, errors.New("no audio to measure")
	}
	tracks = min(tracks, maxTracks)
	tailStart := max(0, duration-float64(profile.TailSeconds))
	for track := range tracks {
		pcm, err := decode(ctx, ffmpeg, input, track, 0, profile.HeadSeconds)
		if err != nil {
			return nil, nil, 0, err
		}
		head = append(head, Part{Track: track, Start: 0, Points: Fingerprint(pcm)})
		if tailStart > float64(profile.HeadSeconds) {
			pcm, err := decode(ctx, ffmpeg, input, track, tailStart, profile.TailSeconds)
			if err != nil {
				return nil, nil, 0, err
			}
			tail = append(tail, Part{Track: track, Start: tailStart, Points: Fingerprint(pcm)})
		}
	}
	return head, tail, duration, nil
}

// MeasureWhole fingerprints the first audio track of a short file (a
// creditless opening or ending).
func MeasureWhole(ctx context.Context, ffmpeg, input string, maxSeconds int) ([]uint32, error) {
	pcm, err := decode(ctx, ffmpeg, input, 0, 0, maxSeconds)
	if err != nil {
		return nil, err
	}
	return Fingerprint(pcm), nil
}

// decode returns mono PCM at SampleRate for seconds of one audio track,
// starting at from.
func decode(ctx context.Context, ffmpeg, input string, track int, from float64, seconds int) ([]int16, error) {
	args := []string{"-nostdin", "-v", "error"}
	if from > 0 {
		args = append(args, "-ss", strconv.FormatFloat(from, 'f', 3, 64))
	}
	args = append(args, "-i", input, "-map", "0:a:"+strconv.Itoa(track), "-t", strconv.Itoa(seconds),
		"-ac", "1", "-ar", strconv.Itoa(SampleRate), "-f", "s16le", "pipe:1")
	cmd := exec.CommandContext(ctx, ffmpeg, args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	raw, readErr := io.ReadAll(bufio.NewReaderSize(stdout, 256<<10))
	waitErr := cmd.Wait()
	if readErr != nil {
		return nil, readErr
	}
	if len(raw) < 2*SampleRate*5 {
		if waitErr != nil {
			return nil, fmt.Errorf("ffmpeg: %w: %s", waitErr, strings.TrimSpace(stderr.String()))
		}
		return nil, errors.New("too little audio decoded")
	}
	pcm := make([]int16, len(raw)/2)
	for i := range pcm {
		pcm[i] = int16(binary.LittleEndian.Uint16(raw[2*i:]))
	}
	return pcm, nil
}
