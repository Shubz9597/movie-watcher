package subsync

import (
	"bytes"
	"compress/gzip"
	"context"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Recorded from the AnimeRG Dragon Ball Z Kai release, episode 20: the
// English 5.1 track's dialogue envelope (centre channel, quantized) and the
// cue timings (no text) of three English subtitles: OpenSubtitles 13701177
// (dub captions timed for another release), 4486723 (a dub script in sync)
// and the release's own track (a translation of the Japanese audio).
func loadFixture(t *testing.T) (Envelope, map[string]string) {
	t.Helper()
	raw, err := os.ReadFile("testdata/dbz_kai_ep20_english_dialogue.env.gz")
	if err != nil {
		t.Fatal(err)
	}
	zr, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	quantized, err := io.ReadAll(zr)
	if err != nil {
		t.Fatal(err)
	}
	values := make([]float64, len(quantized))
	for i, b := range quantized {
		values[i] = float64(int8(b))
	}
	subs := map[string]string{}
	for _, name := range []string{"dub_captions_4s_late", "dub_script_in_sync", "japanese_translation"} {
		text, err := os.ReadFile("testdata/dbz_kai_ep20_" + name + ".timings")
		if err != nil {
			t.Fatal(err)
		}
		subs[name] = string(text)
	}
	return normalize(values), subs
}

func TestAlignFindsTheDubCaptionsOffset(t *testing.T) {
	env, subs := loadFixture(t)
	for name, want := range map[string]struct {
		shift float64
		minR  float64
		maxR  float64
	}{
		"dub_captions_4s_late": {shift: -4.0, minR: 0.45, maxR: 1},
		"dub_script_in_sync":   {shift: 0, minR: 0.4, maxR: 1},
		"japanese_translation": {minR: -1, maxR: 0.12},
	} {
		match := Align(env, ParseCues(subs[name]), MaxShift)
		if match.R < want.minR || match.R > want.maxR {
			t.Errorf("%s: r = %.3f, want %.2f..%.2f", name, match.R, want.minR, want.maxR)
		}
		if want.minR > 0 && math.Abs(match.Offset()-want.shift) > 0.15 {
			t.Errorf("%s: offset %.1f s, want %.1f s (match %+v)", name, match.Offset(), want.shift, match)
		}
	}
}

func TestPickDubPrefersADubScriptOverTheTranslation(t *testing.T) {
	env, subs := loadFixture(t)
	baseline := Align(env, ParseCues(subs["japanese_translation"]), MaxShift).R
	judged := Judge(env, []Candidate{
		{Name: "translation", Text: subs["japanese_translation"]},
		{Name: "dub captions", Text: subs["dub_captions_4s_late"]},
		{Name: "dub script", Text: subs["dub_script_in_sync"]},
	})
	dub, ok := PickDub(judged, baseline)
	if !ok || !strings.HasPrefix(dub.Name, "dub") {
		t.Fatalf("picked %q (ok=%v), judged %+v", dub.Name, ok, judged)
	}
	// Only translations available: no dub is claimed.
	onlyTranslation := Judge(env, []Candidate{{Name: "translation", Text: subs["japanese_translation"]}})
	if picked, ok := PickDub(onlyTranslation, baseline); ok {
		t.Fatalf("a translation was taken for the dub: %+v", picked)
	}
}

func TestShiftMovesCuesAndMarksTheDub(t *testing.T) {
	// A cue moved before 0 is dropped; one straddling 0 starts at 0.
	srt := "1\r\n00:00:01,000 --> 00:00:02,500\r\nGone\r\n\r\n2\r\n00:00:02,000 --> 00:00:04,500\r\nFirst line\r\n\r\n3\r\n00:00:10,000 --> 00:00:12,000\r\n<i>Second</i>\r\nline two\r\n"
	got := Shift(srt, -3, DubNote)
	want := "WEBVTT\n\nNOTE " + DubNote + "\n\n00:00:00.000 --> 00:00:01.500\nFirst line\n\n00:00:07.000 --> 00:00:09.000\n<i>Second</i>\nline two\n\n"
	if got != want {
		t.Fatalf("shifted:\n%q\nwant:\n%q", got, want)
	}
	vtt := "\ufeffWEBVTT\n\nNOTE source\n\n00:01.500 --> 00:03.000 align:start\nHello\n"
	if got := Shift(vtt, 1.25, ""); got != "WEBVTT\n\n00:00:02.750 --> 00:00:04.250 align:start\nHello\n\n" {
		t.Fatalf("vtt shifted: %q", got)
	}
}

func TestParseCuesReadsBothFormats(t *testing.T) {
	cues := ParseCues("WEBVTT\n\n01:02.5 --> 01:04.250\nx\n\n1\n01:00:00,100 --> 01:00:01,000\ny\n")
	if len(cues) != 2 || cues[0] != (Cue{62.5, 64.25}) || math.Abs(cues[1].Start-3600.1) > 1e-9 {
		t.Fatalf("cues = %+v", cues)
	}
}

func TestLanguageAndDualAudio(t *testing.T) {
	tracks := []AudioTrack{{Index: 1, Language: "eng", Channels: 6, Layout: "5.1"}, {Index: 2, Language: "jpn", Channels: 2, Layout: "stereo"}}
	track, ok, dual := TrackFor(tracks, "en")
	if !ok || track.Index != 1 || !dual || !hasCentre(track) || hasCentre(tracks[1]) {
		t.Fatalf("track %+v ok=%v dual=%v", track, ok, dual)
	}
	if _, ok, dual := TrackFor(tracks[:1], "en"); !ok || dual {
		t.Fatalf("single English track: ok=%v dual=%v", ok, dual)
	}
}

// MeasureDialogue on a generated file: speech-band bursts every 4 s land
// where they were generated.
func TestMeasureDialogueFindsBursts(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg not installed")
	}
	path := filepath.Join(t.TempDir(), "bursts.mka")
	// 1 kHz tone gated on for the first second of every 4 s, 60 s long.
	gen := exec.Command(ffmpeg, "-v", "error", "-f", "lavfi", "-i",
		"sine=frequency=1000:sample_rate=48000:duration=60", "-af", "volume='if(lt(mod(t,4),1),1,0.001)':eval=frame",
		"-c:a", "pcm_s16le", path)
	if out, err := gen.CombinedOutput(); err != nil {
		t.Fatalf("generate: %v %s", err, out)
	}
	env, err := MeasureDialogue(context.Background(), ffmpeg, path, nil, AudioTrack{Index: 0, Channels: 1, Layout: "mono"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(env) < 590 || len(env) > 601 {
		t.Fatalf("envelope length %d, want ~600", len(env))
	}
	var cues []Cue
	for start := 0.0; start < 60; start += 4 {
		cues = append(cues, Cue{start, start + 1})
	}
	shifted := make([]Cue, len(cues))
	for i, c := range cues {
		shifted[i] = Cue{c.Start + 2, c.End + 2}
	}
	if m := Align(env, shifted, 3); math.Abs(m.Shift+2) > 0.15 || m.R < 0.8 {
		t.Fatalf("align: %+v", m)
	}
}
