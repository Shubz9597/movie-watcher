package transcribe

import (
	"os"
	"strings"
	"testing"
)

// The first three minutes of Dragon Ball Z Kai S2E1's English dub as
// Transcribe heard them (base.en, speech found by Silero and transcribed in
// chunks), and the online English subtitle for that episode: a translation
// of the Japanese, timed to the same lip movements.
func kaiWords(t *testing.T) []Word {
	t.Helper()
	words, err := Load("testdata/kai_s2e1_words.json")
	if err != nil {
		t.Fatal(err)
	}
	if len(words) < 150 {
		t.Fatalf("loaded %d words", len(words))
	}
	return words
}

func TestParseWhisperJSONDropsMusicAndCapsWords(t *testing.T) {
	words, err := parseWhisperJSON([]byte(`{"transcription":[
		{"offsets":{"from":0,"to":7000},"text":" [MUSIC]"},
		{"offsets":{"from":7020,"to":7290},"text":" The"},
		{"offsets":{"from":7290,"to":7290},"text":""},
		{"offsets":{"from":47050,"to":73170},"text":" defeated"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(words) != 2 || words[0].Text != "The" || words[0].Start != 7.02 {
		t.Fatalf("words %+v", words)
	}
	if words[1].End-words[1].Start > maxWordSeconds {
		t.Errorf("a stretched word lasts %.1f s", words[1].End-words[1].Start)
	}
}

func TestChunksFollowTheSpeech(t *testing.T) {
	speech := parseSegments("Speech segment 0: start = 710.00, end = 1338.00\nSpeech segment 1: start = 1369.00, end = 2615.00\nSpeech segment 2: start = 4015.00, end = 4727.00\n")
	chunks := chunkSegments(speech, 180)
	if len(chunks) != 2 {
		t.Fatalf("chunks %+v", chunks)
	}
	// 7.1-13.4 and 13.7-26.2 are one stretch of narration; 40.2-47.3 another.
	if chunks[0].Start != 6.5 || chunks[0].End > 26.5 || chunks[1].Start != 39.55 {
		t.Errorf("chunks %+v", chunks)
	}
}

func TestWordMatchTellsTheDubFromATranslation(t *testing.T) {
	words := kaiWords(t)
	translation, err := os.ReadFile("testdata/kai_s2e1_translation.vtt")
	if err != nil {
		t.Fatal(err)
	}
	own := WebVTT(Cues(words), "")
	dub, other := WordMatch(words, own), WordMatch(words, string(translation))
	t.Logf("dub's own words %.2f, translation %.2f", dub, other)
	if dub < 0.9 {
		t.Errorf("the audio's own words match %.2f, want >= 0.9", dub)
	}
	if other >= DubWordMatch {
		t.Errorf("the translation matches %.2f, want < %.2f", other, DubWordMatch)
	}
}

func TestCuesReadLikeSubtitles(t *testing.T) {
	cues := Cues(kaiWords(t))
	if len(cues) < 20 {
		t.Fatalf("%d cues for three minutes", len(cues))
	}
	for i, cue := range cues {
		lines := strings.Split(cue.Text, "\n")
		if len(lines) > 2 {
			t.Errorf("cue %d has %d lines: %q", i, len(lines), cue.Text)
		}
		for _, line := range lines {
			if len(line) > lineChars+12 {
				t.Errorf("cue %d line of %d chars: %q", i, len(line), line)
			}
		}
		if d := cue.End - cue.Start; d < 0.9 || d > cueSeconds+2 {
			t.Errorf("cue %d lasts %.2f s: %q", i, d, cue.Text)
		}
		if i > 0 && cue.Start < cues[i-1].End {
			t.Errorf("cue %d overlaps the one before", i)
		}
	}
	// The narration's first sentence is one cue, not cut mid-phrase.
	if first := strings.ReplaceAll(cues[0].Text, "\n", " "); !strings.HasPrefix(first, "The seven magic dragon balls") {
		t.Errorf("first cue %q", first)
	}
	vtt := WebVTT(cues, "torwatch-variant: dub")
	if !strings.HasPrefix(vtt, "WEBVTT\n\nNOTE torwatch-variant: dub\n\n00:00:06.") {
		t.Errorf("vtt starts %q", vtt[:60])
	}
}

func TestPromptNamesTheCharacters(t *testing.T) {
	translation, _ := os.ReadFile("testdata/kai_s2e1_translation.vtt")
	prompt := Prompt("Dragon Ball Z Kai", []string{string(translation)})
	t.Log(prompt)
	if !strings.HasPrefix(prompt, "Dragon Ball Z Kai.") || !strings.Contains(prompt, "Gohan") {
		t.Errorf("prompt %q", prompt)
	}
}
