package downloads

import (
	"context"
	"encoding/binary"
	"fmt"
	"math"
	"math/rand/v2"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"torrent-streamer/internal/subsync"
)

// speech generates irregular "lines": count bursts of a speech-band tone
// with random lengths and gaps, starting after lead seconds.
func speech(seed uint64, count int, lead float64) []subsync.Cue {
	r := rand.New(rand.NewPCG(seed, 7))
	var cues []subsync.Cue
	at := lead
	for range count {
		length := 1 + r.Float64()*3
		cues = append(cues, subsync.Cue{Start: at, End: at + length})
		at += length + 0.8 + r.Float64()*4
	}
	return cues
}

func writeWAV(t *testing.T, path string, cues []subsync.Cue, seconds int) {
	t.Helper()
	const rate = 8000
	samples := make([]int16, rate*seconds)
	for _, cue := range cues {
		for i := int(cue.Start * rate); i < int(cue.End*rate) && i < len(samples); i++ {
			samples[i] = int16(9000 * math.Sin(2*math.Pi*700*float64(i)/rate))
		}
	}
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	data := len(samples) * 2
	header := []any{[4]byte{'R', 'I', 'F', 'F'}, uint32(36 + data), [4]byte{'W', 'A', 'V', 'E'},
		[4]byte{'f', 'm', 't', ' '}, uint32(16), uint16(1), uint16(1), uint32(rate), uint32(rate * 2), uint16(2), uint16(16),
		[4]byte{'d', 'a', 't', 'a'}, uint32(data)}
	for _, v := range header {
		if err := binary.Write(f, binary.LittleEndian, v); err != nil {
			t.Fatal(err)
		}
	}
	if err := binary.Write(f, binary.LittleEndian, samples); err != nil {
		t.Fatal(err)
	}
}

func srt(cues []subsync.Cue, shift float64) string {
	var b strings.Builder
	stamp := func(s float64) string {
		ms := int(math.Round(s * 1000))
		return fmt.Sprintf("%02d:%02d:%02d,%03d", ms/3600000, ms/60000%60, ms/1000%60, ms%1000)
	}
	for i, cue := range cues {
		fmt.Fprintf(&b, "%d\n%s --> %s\nline %d\n\n", i+1, stamp(cue.Start+shift), stamp(cue.End+shift), i+1)
	}
	return b.String()
}

func requireTools(t *testing.T) {
	t.Helper()
	for _, tool := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skip(tool + " not installed")
		}
	}
}

// mkv muxes audio tracks (language, cues) and an optional embedded subtitle.
func mkv(t *testing.T, dir string, audio []struct {
	lang string
	cues []subsync.Cue
}, embedded string) string {
	t.Helper()
	const seconds = 300
	args := []string{"-v", "error"}
	for i, track := range audio {
		path := filepath.Join(dir, fmt.Sprintf("a%d.wav", i))
		writeWAV(t, path, track.cues, seconds)
		args = append(args, "-i", path)
	}
	if embedded != "" {
		path := filepath.Join(dir, "embedded.srt")
		if err := os.WriteFile(path, []byte(embedded), 0o644); err != nil {
			t.Fatal(err)
		}
		args = append(args, "-i", path)
	}
	for i := range audio {
		args = append(args, "-map", fmt.Sprintf("%d:a", i))
	}
	if embedded != "" {
		args = append(args, "-map", fmt.Sprintf("%d:s", len(audio)))
	}
	for i, track := range audio {
		args = append(args, fmt.Sprintf("-metadata:s:a:%d", i), "language="+track.lang)
	}
	if embedded != "" {
		args = append(args, "-metadata:s:s:0", "language=eng")
	}
	out := filepath.Join(dir, "video.mkv")
	args = append(args, "-c:a", "pcm_s16le", "-c:s", "srt", out)
	if b, err := exec.Command("ffmpeg", args...).CombinedOutput(); err != nil {
		t.Fatalf("mux: %v %s", err, b)
	}
	return out
}

func TestChooseSubtitleTakesTheDubAndMovesIt(t *testing.T) {
	requireTools(t)
	dir := t.TempDir()
	english, japanese := speech(1, 60, 3), speech(2, 60, 3)
	video := mkv(t, dir, []struct {
		lang string
		cues []subsync.Cue
	}{{"eng", english}, {"jpn", japanese}}, srt(japanese, 0))
	embedded, err := extractEmbeddedSubtitle(context.Background(), video, "en")
	if err != nil {
		t.Fatal(err)
	}
	candidates := []ProviderSubtitle{
		{Name: "translation", Data: []byte(srt(japanese, 0.5)), Ext: "srt"},
		{Name: "dub captions", Data: []byte(srt(english, 4)), Ext: "srt"},
	}
	choice, ok := chooseSubtitle(context.Background(), "test", video, "en", "", embedded, candidates)
	if !ok || !strings.Contains(choice.why, "dub captions") {
		t.Fatalf("choice %q ok=%v", choice.why, ok)
	}
	text := string(choice.data)
	if !strings.Contains(text, "NOTE "+subsync.DubNote) {
		t.Fatalf("dub not marked:\n%.200s", text)
	}
	got := subsync.ParseCues(text)
	if len(got) == 0 || math.Abs(got[0].Start-english[0].Start) > 0.15 {
		t.Fatalf("first cue at %.2f, want %.2f (moved back 4 s)", got[0].Start, english[0].Start)
	}
}

func TestChooseSubtitleSyncsAProviderSubtitleWithoutAnOwnTrack(t *testing.T) {
	requireTools(t)
	dir := t.TempDir()
	dialogue := speech(3, 60, 2)
	video := mkv(t, dir, []struct {
		lang string
		cues []subsync.Cue
	}{{"eng", dialogue}}, "")
	choice, ok := chooseSubtitle(context.Background(), "test", video, "en", "", nil,
		[]ProviderSubtitle{{Name: "other release", Data: []byte(srt(dialogue, 3.5)), Ext: "srt"}})
	if !ok || strings.Contains(string(choice.data), subsync.DubNote) {
		t.Fatalf("choice %q ok=%v (single audio is not a dub)", choice.why, ok)
	}
	if got := subsync.ParseCues(string(choice.data)); math.Abs(got[0].Start-dialogue[0].Start) > 0.15 {
		t.Fatalf("first cue at %.2f, want %.2f", got[0].Start, dialogue[0].Start)
	}
}

func TestChooseSubtitleKeepsTheOwnTrackWithoutADub(t *testing.T) {
	requireTools(t)
	dir := t.TempDir()
	english, japanese := speech(4, 60, 3), speech(5, 60, 3)
	video := mkv(t, dir, []struct {
		lang string
		cues []subsync.Cue
	}{{"eng", english}, {"jpn", japanese}}, srt(japanese, 0))
	embedded, err := extractEmbeddedSubtitle(context.Background(), video, "en")
	if err != nil {
		t.Fatal(err)
	}
	choice, ok := chooseSubtitle(context.Background(), "test", video, "en", "", embedded,
		[]ProviderSubtitle{{Name: "another translation", Data: []byte(srt(japanese, 1)), Ext: "srt"}})
	if !ok || choice.why != "the video's own track" {
		t.Fatalf("choice %q ok=%v", choice.why, ok)
	}
}
