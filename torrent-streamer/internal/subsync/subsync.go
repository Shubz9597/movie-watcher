// Package subsync measures how well a subtitle fits a video's dialogue and
// moves it onto that dialogue.
//
// Online subtitles are often timed for another release of the same episode
// (a TV rip with a few extra seconds before the opening): Dragon Ball Z Kai's
// English dub captions ran exactly 4.0 s late against the AnimeRG release.
// Dialogue is loud speech-band audio; a subtitle's cues are where text is
// shown. Correlating the two over a range of shifts finds the offset, and the
// strength of the best correlation says which audio a subtitle belongs to:
// measured on that episode, dub captions scored 0.46-0.54 against the English
// audio while translations of the Japanese scored 0.07.
package subsync

import (
	"bufio"
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os/exec"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// Rate is the resolution of envelopes and shifts: one value per 100 ms.
const Rate = 10

// Envelope is a track's dialogue loudness, one z-normalized value per 1/Rate
// second from the start of the video.
type Envelope []float64

// Cue is one subtitle line's display interval in seconds.
type Cue struct{ Start, End float64 }

// Match is how a subtitle fits an envelope: R (Pearson correlation of its
// cues with dialogue loudness, -1..1) at the best Shift (seconds to add to
// every cue), and RAtZero without shifting.
type Match struct {
	Shift   float64
	R       float64
	RAtZero float64
}

// AudioTrack is one audio stream of a video file.
type AudioTrack struct {
	Index    int    // absolute stream index (ffmpeg -map 0:<Index>)
	Language string // as tagged (eng, jpn, en, ...); may be empty
	Channels int
	Layout   string
}

const (
	sampleRate     = 4000
	samplesPerStep = sampleRate / Rate
)

// MeasureDialogue decodes one audio stream of input (a path, URL, or "pipe:0"
// with stdin) for at most maxSeconds and returns its dialogue envelope. The
// centre channel carries dialogue in surround mixes; stereo is mixed down.
func MeasureDialogue(ctx context.Context, ffmpeg, input string, stdin io.Reader, track AudioTrack, maxSeconds int) (Envelope, error) {
	filter := "highpass=f=200,lowpass=f=3500"
	if hasCentre(track) {
		filter = "pan=mono|c0=FC," + filter
	}
	args := []string{"-nostdin", "-v", "error", "-i", input, "-map", "0:" + strconv.Itoa(track.Index)}
	if maxSeconds > 0 {
		args = append(args, "-t", strconv.Itoa(maxSeconds))
	}
	args = append(args, "-af", filter, "-ac", "1", "-ar", strconv.Itoa(sampleRate), "-f", "s16le", "pipe:1")
	cmd := exec.CommandContext(ctx, ffmpeg, args...)
	if stdin != nil {
		cmd.Stdin = stdin
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	energies, readErr := stepEnergies(bufio.NewReaderSize(stdout, 64<<10))
	waitErr := cmd.Wait()
	if readErr != nil {
		return nil, readErr
	}
	// A pipe input cut short (the caller stops feeding it) still yields a
	// usable envelope; only an empty one is a failure.
	if len(energies) < 30*Rate {
		if waitErr != nil {
			return nil, fmt.Errorf("ffmpeg: %w: %s", waitErr, strings.TrimSpace(stderr.String()))
		}
		return nil, errors.New("too little audio to measure dialogue")
	}
	return normalize(energies), nil
}

// hasCentre reports a surround layout with a front-centre channel.
func hasCentre(track AudioTrack) bool {
	layout := strings.ToLower(track.Layout)
	for _, name := range []string{"3.0", "3.1", "4.0", "5.0", "5.1", "6.0", "6.1", "7.0", "7.1"} {
		if strings.HasPrefix(layout, name) {
			return true
		}
	}
	return layout == "" && track.Channels >= 6
}

// stepEnergies reads 16-bit mono samples and returns log energy per step.
func stepEnergies(r io.Reader) ([]float64, error) {
	buf := make([]byte, samplesPerStep*2)
	var out []float64
	for {
		if _, err := io.ReadFull(r, buf); err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
				return out, nil
			}
			return out, err
		}
		var sum float64
		for i := 0; i < len(buf); i += 2 {
			sample := float64(int16(uint16(buf[i]) | uint16(buf[i+1])<<8))
			sum += sample * sample
		}
		out = append(out, math.Log10(1+sum/samplesPerStep))
	}
}

func normalize(values []float64) Envelope {
	var mean float64
	for _, v := range values {
		mean += v
	}
	mean /= float64(len(values))
	var variance float64
	for _, v := range values {
		variance += (v - mean) * (v - mean)
	}
	sd := math.Sqrt(variance / float64(len(values)))
	if sd == 0 {
		sd = 1
	}
	env := make(Envelope, len(values))
	for i, v := range values {
		env[i] = (v - mean) / sd
	}
	return env
}

var timingLine = regexp.MustCompile(`(?m)^\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})`)

// ParseCues reads the cue timings of a WebVTT or SRT document.
func ParseCues(text string) []Cue {
	var cues []Cue
	for _, m := range timingLine.FindAllStringSubmatch(text, -1) {
		start, okStart := parseTimestamp(m[1])
		end, okEnd := parseTimestamp(m[2])
		if okStart && okEnd && end > start {
			cues = append(cues, Cue{Start: start, End: end})
		}
	}
	return cues
}

func parseTimestamp(value string) (float64, bool) {
	parts := strings.Split(strings.ReplaceAll(value, ",", "."), ":")
	var seconds float64
	for _, part := range parts {
		n, err := strconv.ParseFloat(part, 64)
		if err != nil {
			return 0, false
		}
		seconds = seconds*60 + n
	}
	return seconds, true
}

// Align finds the shift within ±maxShift seconds that best lines cues up
// with the envelope's dialogue. Cues outside the measured audio are ignored.
func Align(env Envelope, cues []Cue, maxShift float64) Match {
	n := len(env)
	if n == 0 || len(cues) == 0 {
		return Match{}
	}
	prefix := make([]float64, n+1)
	for i, v := range env {
		prefix[i+1] = prefix[i] + v
	}
	cues = slices.Clone(cues)
	slices.SortFunc(cues, func(a, b Cue) int { return cmp.Compare(a.Start, b.Start) })
	steps := int(math.Round(maxShift * Rate))
	best := Match{R: math.Inf(-1)}
	for step := -steps; step <= steps; step++ {
		if r := correlation(prefix, n, cues, step); r > best.R {
			best = Match{Shift: float64(step) / Rate, R: r}
		}
	}
	best.RAtZero = correlation(prefix, n, cues, 0)
	return best
}

// Thresholds, from Dragon Ball Z Kai episode 20 (English 5.1 audio): dub
// captions 0.46 and 0.54, Japanese translations 0.07.
const (
	// DubMinR: a subtitle at least this close to a dub's dialogue is that
	// dub's script, provided it also beats the video's own track clearly.
	DubMinR = 0.25
	// SyncMinR: below this a best shift is noise, not an offset.
	SyncMinR = 0.15
	// MaxShift bounds the search (seconds either way).
	MaxShift = 12.0
)

// Candidate is one subtitle document to judge against an audio track.
type Candidate struct {
	Name string
	Text string
}

// Judged is a candidate with its fit to the audio.
type Judged struct {
	Candidate
	Match
}

// Judge aligns every candidate with the envelope, best fit first.
func Judge(env Envelope, candidates []Candidate) []Judged {
	judged := make([]Judged, 0, len(candidates))
	for _, candidate := range candidates {
		cues := ParseCues(candidate.Text)
		if len(cues) < 10 {
			continue
		}
		judged = append(judged, Judged{Candidate: candidate, Match: Align(env, cues, MaxShift)})
	}
	slices.SortStableFunc(judged, func(a, b Judged) int { return cmp.Compare(b.R, a.R) })
	return judged
}

// PickDub returns the best candidate when it follows this audio's dialogue
// (a dub's script, or any subtitle written for this audio) clearly better
// than baselineR, the fit of the subtitle the video already carries (0 when
// it has none).
func PickDub(judged []Judged, baselineR float64) (Judged, bool) {
	if len(judged) == 0 {
		return Judged{}, false
	}
	best := judged[0]
	return best, best.R >= DubMinR && best.R >= 2*baselineR
}

// Offset is the shift to apply: the best one when it is a real improvement
// on the timing as published, else 0.
func (m Match) Offset() float64 {
	if m.R < SyncMinR || math.Abs(m.Shift) < 0.3 || m.R-m.RAtZero < 0.02 {
		return 0
	}
	return m.Shift
}

// correlation is Pearson's r between the (z-normalized) envelope and the
// 0/1 "text on screen" mask of the cues moved by step: with the envelope's
// mean 0 and deviation 1, r = sum(env under text) / (n * sd(mask)).
func correlation(prefix []float64, n int, cues []Cue, step int) float64 {
	covered, sum, last := 0, 0.0, 0
	for _, cue := range cues {
		from := max(int(math.Round(cue.Start*Rate))+step, last)
		to := min(int(math.Round(cue.End*Rate))+step, n)
		if from < 0 {
			from = 0
		}
		if to <= from {
			continue
		}
		sum += prefix[to] - prefix[from]
		covered += to - from
		last = to
	}
	if covered == 0 || covered == n {
		return 0
	}
	p := float64(covered) / float64(n)
	return sum / (float64(n) * math.Sqrt(p*(1-p)))
}

// Shift moves every cue of a WebVTT or SRT document by seconds and returns
// WebVTT. Cues that would end before 0 are dropped; a start before 0 is
// clamped. note, when set, is written as a NOTE block after the header.
func Shift(text string, seconds float64, note string) string {
	text = strings.TrimPrefix(strings.ReplaceAll(text, "\r\n", "\n"), "\ufeff")
	var out strings.Builder
	out.WriteString("WEBVTT\n\n")
	if note != "" {
		out.WriteString("NOTE " + note + "\n\n")
	}
	for _, block := range strings.Split(text, "\n\n") {
		lines := strings.Split(strings.Trim(block, "\n"), "\n")
		at := -1
		for i, line := range lines {
			if strings.Contains(line, "-->") {
				at = i
				break
			}
		}
		if at < 0 {
			continue // header, NOTE, STYLE or SRT counter-only fragments
		}
		m := timingLine.FindStringSubmatch(lines[at])
		if m == nil {
			continue
		}
		start, _ := parseTimestamp(m[1])
		end, _ := parseTimestamp(m[2])
		start, end = start+seconds, end+seconds
		if end <= 0 {
			continue
		}
		start = math.Max(0, start)
		settings := strings.TrimSpace(lines[at][len(m[0]):])
		timing := formatTimestamp(start) + " --> " + formatTimestamp(end)
		if settings != "" {
			timing += " " + settings
		}
		out.WriteString(timing + "\n")
		for _, line := range lines[at+1:] {
			out.WriteString(line + "\n")
		}
		out.WriteString("\n")
	}
	return out.String()
}

func formatTimestamp(seconds float64) string {
	ms := int64(math.Round(seconds * 1000))
	return fmt.Sprintf("%02d:%02d:%02d.%03d", ms/3_600_000, ms/60_000%60, ms/1000%60, ms%1000)
}

// ProbeAudio lists a video's audio streams (input as for MeasureDialogue).
func ProbeAudio(ctx context.Context, ffprobe, input string, stdin io.Reader) ([]AudioTrack, error) {
	cmd := exec.CommandContext(ctx, ffprobe, "-v", "error", "-select_streams", "a",
		"-show_entries", "stream=index,channels,channel_layout:stream_tags=language",
		"-of", "json", input)
	if stdin != nil {
		cmd.Stdin = stdin
	}
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("ffprobe: %w", err)
	}
	var payload struct {
		Streams []struct {
			Index         int    `json:"index"`
			Channels      int    `json:"channels"`
			ChannelLayout string `json:"channel_layout"`
			Tags          struct {
				Language string `json:"language"`
			} `json:"tags"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(out, &payload); err != nil {
		return nil, err
	}
	tracks := make([]AudioTrack, 0, len(payload.Streams))
	for _, s := range payload.Streams {
		tracks = append(tracks, AudioTrack{Index: s.Index, Language: s.Tags.Language, Channels: s.Channels, Layout: s.ChannelLayout})
	}
	return tracks, nil
}

// LanguageMatches reports whether a stream language tag (ISO 639-1/2, any
// case) names lang (ISO 639-1).
func LanguageMatches(tag, lang string) bool {
	tag, lang = strings.ToLower(strings.TrimSpace(tag)), strings.ToLower(lang)
	if tag == "" || lang == "" {
		return false
	}
	if tag == lang {
		return true
	}
	return slices.Contains(threeLetter[lang], tag)
}

var threeLetter = map[string][]string{
	"en": {"eng"}, "ja": {"jpn"}, "es": {"spa"}, "fr": {"fre", "fra"}, "de": {"ger", "deu"},
	"it": {"ita"}, "pt": {"por"}, "hi": {"hin"}, "ko": {"kor"}, "zh": {"chi", "zho"},
	"ru": {"rus"}, "ar": {"ara"}, "ta": {"tam"}, "te": {"tel"},
}

// TrackFor returns the audio track in lang, and whether the video also has
// audio in another language (a dual-audio release).
func TrackFor(tracks []AudioTrack, lang string) (AudioTrack, bool, bool) {
	var found AudioTrack
	ok, other := false, false
	for _, track := range tracks {
		if LanguageMatches(track.Language, lang) {
			if !ok {
				found, ok = track, true
			}
		} else if track.Language != "" && !strings.EqualFold(track.Language, "und") {
			other = true
		}
	}
	return found, ok, other
}

// DubNote marks a subtitle the server matched to a dub (a WebVTT NOTE); the
// players label such a track as the dub's.
const DubNote = "torwatch-variant: dub"
