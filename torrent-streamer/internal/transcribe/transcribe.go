// Package transcribe writes subtitles from a video's own speech with
// whisper.cpp (speech-to-text on the CPU). A dub's script is a different
// text from the translation of the original language that online subtitles
// carry (Dragon Ball Z Kai's English dub: "The seven magic dragon balls...",
// the subtitle: "The seven Dragon Balls, when gathered together..."), and
// both are timed to the same lip movements, so only the words tell them
// apart.
package transcribe

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
)

// DubWordMatch: a subtitle sharing at least this share of the audio's word
// pairs is written from that audio (a dub's script), not a translation.
const DubWordMatch = 0.4

// Word is one spoken word with its time in the video (seconds).
type Word struct {
	Start float64 `json:"start"`
	End   float64 `json:"end"`
	Text  string  `json:"text"`
}

func envOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func cliPath() string   { return envOr("WHISPER_CLI_PATH", "/usr/local/bin/whisper-cli") }
func modelPath() string { return envOr("WHISPER_MODEL_PATH", "/opt/whisper/ggml-base.en.bin") }
func vadCLIPath() string {
	return envOr("WHISPER_VAD_CLI_PATH", "/usr/local/bin/whisper-vad-speech-segments")
}
func vadModelPath() string { return envOr("WHISPER_VAD_MODEL_PATH", "/opt/whisper/ggml-silero.bin") }

// Available reports whether the engine and its model are installed.
func Available() bool {
	for _, path := range []string{cliPath(), modelPath(), vadCLIPath(), vadModelPath()} {
		if info, err := os.Stat(path); err != nil || info.IsDir() {
			return false
		}
	}
	return true
}

// slot runs one transcription at a time: a season queued at once must not
// start sixty of them.
var slot = make(chan struct{}, 1)

// Transcribe returns the words spoken in input's audio stream audioIndex
// (ffmpeg -map 0:<audioIndex>). prompt names people and places the model
// would otherwise mishear ("Saiyan", "Gohan").
//
// Speech is found first (Silero voice detection) and each stretch of it,
// at most 25 s, is transcribed on its own, so every word keeps its place in
// the episode. Run over the whole track at once, whisper.cpp heard
// narration over music as [MUSIC] (Kai S2E1's first 30 s were lost), and
// its built-in voice detection put words up to 25 s from where they are
// spoken.
func Transcribe(ctx context.Context, ffmpeg, input string, audioIndex int, prompt string) ([]Word, error) {
	if !Available() {
		return nil, errors.New("speech-to-text is not installed")
	}
	select {
	case slot <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	defer func() { <-slot }()

	dir, err := os.MkdirTemp("", "torwatch-transcribe-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	decode := exec.CommandContext(ctx, ffmpeg, "-nostdin", "-v", "error", "-i", input,
		"-map", "0:"+strconv.Itoa(audioIndex), "-ac", "1", "-ar", strconv.Itoa(sampleRate), "-f", "s16le", "-")
	var stderr strings.Builder
	decode.Stderr = &stderr
	pcm, err := decode.Output()
	if err != nil {
		return nil, fmt.Errorf("ffmpeg: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	whole := filepath.Join(dir, "audio.wav")
	if err := writeWAV(whole, pcm); err != nil {
		return nil, err
	}
	threads := runtime.NumCPU() - 2 // a little CPU for streams playing meanwhile
	if threads < 2 {
		threads = 2
	}
	speech, err := speechSegments(ctx, whole, threads)
	if err != nil {
		return nil, err
	}
	chunks := chunkSegments(speech, float64(len(pcm)/2)/sampleRate)
	if len(chunks) == 0 {
		return nil, nil
	}
	args := []string{"-m", modelPath(), "-l", "en", "-t", strconv.Itoa(threads), "-ml", "1", "-sow", "-oj", "-sns", "-np"}
	if strings.TrimSpace(prompt) != "" {
		args = append(args, "--prompt", prompt)
	}
	for i, chunk := range chunks {
		from, to := int(chunk.Start*sampleRate)*2, int(chunk.End*sampleRate)*2
		if to > len(pcm) {
			to = len(pcm)
		}
		path := filepath.Join(dir, fmt.Sprintf("c%04d.wav", i))
		if err := writeWAV(path, pcm[from:to]); err != nil {
			return nil, err
		}
		args = append(args, "-f", path)
	}
	run := exec.CommandContext(ctx, cliPath(), args...)
	if out, err := run.CombinedOutput(); err != nil {
		tail := strings.TrimSpace(string(out))
		if len(tail) > 400 {
			tail = tail[len(tail)-400:]
		}
		return nil, fmt.Errorf("whisper: %w: %s", err, tail)
	}
	var words []Word
	for i, chunk := range chunks {
		data, err := os.ReadFile(filepath.Join(dir, fmt.Sprintf("c%04d.wav.json", i)))
		if err != nil {
			continue // whisper wrote nothing for a chunk without words
		}
		inChunk, err := parseWhisperJSON(data)
		if err != nil {
			return nil, err
		}
		for _, word := range inChunk {
			word.Start += chunk.Start
			word.End += chunk.Start
			if word.End > chunk.End {
				word.End = chunk.End
			}
			if word.Start < chunk.End {
				words = append(words, word)
			}
		}
	}
	return words, nil
}

const sampleRate = 16000

// writeWAV wraps 16 kHz mono 16-bit PCM in a WAV header.
func writeWAV(path string, pcm []byte) error {
	header := make([]byte, 44)
	copy(header[0:], "RIFF")
	binary.LittleEndian.PutUint32(header[4:], uint32(36+len(pcm)))
	copy(header[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(header[16:], 16)
	binary.LittleEndian.PutUint16(header[20:], 1) // PCM
	binary.LittleEndian.PutUint16(header[22:], 1) // mono
	binary.LittleEndian.PutUint32(header[24:], sampleRate)
	binary.LittleEndian.PutUint32(header[28:], sampleRate*2)
	binary.LittleEndian.PutUint16(header[32:], 2)
	binary.LittleEndian.PutUint16(header[34:], 16)
	copy(header[36:], "data")
	binary.LittleEndian.PutUint32(header[40:], uint32(len(pcm)))
	return os.WriteFile(path, append(header, pcm...), 0o600)
}

// Span is a stretch of the audio in seconds.
type Span struct{ Start, End float64 }

var segmentLine = regexp.MustCompile(`start = ([0-9.]+), end = ([0-9.]+)`)

// speechSegments runs Silero voice detection; times come in centiseconds.
// A low threshold keeps quiet lines ("Time for you to take over, Gohan").
func speechSegments(ctx context.Context, wav string, threads int) ([]Span, error) {
	out, err := exec.CommandContext(ctx, vadCLIPath(), "-f", wav, "-vm", vadModelPath(), "-t", strconv.Itoa(threads),
		"-vt", "0.35", "-vsd", "300", "-vp", "200", "-vmsd", "20", "-np").CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("voice detection: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return parseSegments(string(out)), nil
}

func parseSegments(out string) []Span {
	var spans []Span
	for _, match := range segmentLine.FindAllStringSubmatch(out, -1) {
		start, err1 := strconv.ParseFloat(match[1], 64)
		end, err2 := strconv.ParseFloat(match[2], 64)
		if err1 == nil && err2 == nil && end > start {
			spans = append(spans, Span{Start: start / 100, End: end / 100})
		}
	}
	return spans
}

// chunkSegments joins speech stretches less than a second apart into
// chunks of at most 25 s (whisper reads 30 s at a time), padded a little.
func chunkSegments(speech []Span, total float64) []Span {
	// Detection starts a moment late on a line spoken over music ("After a
	// hard fought battle," was cut): more room before than after.
	const maxChunk, joinGap, padBefore, padAfter = 25.0, 1.0, 0.6, 0.3
	var chunks []Span
	for _, span := range speech {
		if n := len(chunks); n > 0 && span.Start-chunks[n-1].End <= joinGap && span.End-chunks[n-1].Start <= maxChunk {
			chunks[n-1].End = span.End
			continue
		}
		chunks = append(chunks, span)
	}
	for i := range chunks {
		chunks[i].Start = max(0, chunks[i].Start-padBefore)
		chunks[i].End = min(total, chunks[i].End+padAfter)
		if i > 0 && chunks[i].Start < chunks[i-1].End {
			chunks[i].Start = chunks[i-1].End
		}
	}
	return chunks
}

// parseWhisperJSON reads whisper-cli's -oj output made with -ml 1 (one word
// per segment, offsets in milliseconds).
func parseWhisperJSON(data []byte) ([]Word, error) {
	var out struct {
		Transcription []struct {
			Offsets struct {
				From int64 `json:"from"`
				To   int64 `json:"to"`
			} `json:"offsets"`
			Text string `json:"text"`
		} `json:"transcription"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}
	words := make([]Word, 0, len(out.Transcription))
	for _, segment := range out.Transcription {
		text := strings.TrimSpace(segment.Text)
		if text == "" || isNonSpeech(text) {
			continue
		}
		word := Word{Start: float64(segment.Offsets.From) / 1000, End: float64(segment.Offsets.To) / 1000, Text: text}
		// A word stretched over a pause would hold its cue on screen.
		if word.End > word.Start+maxWordSeconds {
			word.End = word.Start + maxWordSeconds
		}
		words = append(words, word)
	}
	return words, nil
}

const maxWordSeconds = 2.0

// isNonSpeech: "[MUSIC]", "(laughs)", "♪" and the like.
func isNonSpeech(text string) bool {
	if strings.ContainsRune(text, '♪') {
		return true
	}
	return (strings.HasPrefix(text, "[") && strings.HasSuffix(text, "]")) ||
		(strings.HasPrefix(text, "(") && strings.HasSuffix(text, ")"))
}

// Save and Load keep a transcript beside its download, so it is made once.
func Save(path string, words []Word) error {
	data, err := json.Marshal(words)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func Load(path string) ([]Word, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var words []Word
	if err := json.Unmarshal(data, &words); err != nil {
		return nil, err
	}
	return words, nil
}
