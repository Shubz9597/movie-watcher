package transcribe

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// Cue is one subtitle: up to two lines on screen from Start to End.
type Cue struct {
	Start, End float64
	Text       string
}

const (
	lineChars  = 42  // one subtitle line
	cueChars   = 84  // two lines
	cueSeconds = 6.0 // longest a cue stays up
	pauseGap   = 0.8 // a pause this long starts a new cue
	minSeconds = 1.0 // shortest a cue stays up (time to read it)
	holdAfter  = 0.4 // a cue stays a moment after its last word
	// readingCharsPerSecond: a fast reader; a cue stays up at least this long.
	readingCharsPerSecond = 25.0
)

// Cues groups words into subtitles the way people write them: a new cue at
// a pause, at the end of a sentence (once the cue has some length), and
// before two lines or six seconds are full.
func Cues(words []Word) []Cue {
	var cues []Cue
	var current []Word
	flush := func() {
		if len(current) == 0 {
			return
		}
		texts := make([]string, len(current))
		for i, word := range current {
			texts[i] = word.Text
		}
		cues = append(cues, Cue{Start: current[0].Start, End: current[len(current)-1].End, Text: wrap(strings.Join(texts, " "))})
		current = nil
	}
	length := func(extra Word) int {
		n := len(extra.Text)
		for _, word := range current {
			n += len(word.Text) + 1
		}
		return n
	}
	for _, word := range words {
		if len(current) > 0 {
			last := current[len(current)-1]
			if word.Start-last.End >= pauseGap {
				flush()
			} else if length(word) > cueChars || word.End-current[0].Start > cueSeconds {
				// Full: end the cue at its last comma or full stop when there
				// is one ("...from falling into evil | hands" read badly).
				split := -1
				for i := len(current) - 2; i >= 1; i-- {
					if breaksPhrase(current[i].Text) {
						split = i
						break
					}
				}
				if split < 0 {
					flush()
				} else {
					rest := append([]Word(nil), current[split+1:]...)
					current = current[:split+1]
					flush()
					current = rest
				}
			}
		}
		current = append(current, word)
		chars := length(Word{}) - 1
		if endsSentence(word.Text) && chars >= 25 || strings.HasSuffix(word.Text, ",") && chars >= 60 {
			flush()
		}
	}
	flush()
	// Speech-to-text can repeat itself over music: a cue saying exactly
	// what the one before said goes.
	kept := cues[:0]
	for i, cue := range cues {
		if i > 0 && cue.Text == cues[i-1].Text {
			continue
		}
		kept = append(kept, cue)
	}
	cues = kept
	// Readable timing: a moment after the last word, and time to read it
	// (a second, or 25 characters a second). Whisper can put a chunk's last
	// words on one instant (a 10 ms cue): the next cue then moves later.
	for i := range cues {
		read := float64(len(cues[i].Text)) / readingCharsPerSecond
		if read < minSeconds {
			read = minSeconds
		}
		end := cues[i].End + holdAfter
		if end < cues[i].Start+read {
			end = cues[i].Start + read
		}
		if i+1 < len(cues) {
			next := &cues[i+1]
			if end > next.Start-0.05 && cues[i].End+holdAfter <= next.Start-0.05 {
				end = next.Start - 0.05 // the hold alone would overlap: keep to the gap
			}
			if end > next.Start-0.05 {
				shift := end + 0.05 - next.Start
				next.Start += shift
				if next.End < next.Start {
					next.End = next.Start
				}
			}
		}
		cues[i].End = end
	}
	return cues
}

// breaksPhrase: a word after which a subtitle may end mid-sentence.
func breaksPhrase(text string) bool {
	return endsSentence(text) || strings.HasSuffix(text, ",") || strings.HasSuffix(text, ";") || strings.HasSuffix(text, ":")
}

// abbreviations end with a full stop but not a sentence ("Dr. Gero").
var abbreviations = map[string]bool{"dr.": true, "mr.": true, "mrs.": true, "ms.": true, "st.": true, "vs.": true}

func endsSentence(text string) bool {
	text = strings.TrimRight(text, `"'”’)`)
	if abbreviations[strings.ToLower(text)] {
		return false
	}
	return strings.HasSuffix(text, ".") || strings.HasSuffix(text, "?") || strings.HasSuffix(text, "!") || strings.HasSuffix(text, "…")
}

// wrap breaks a long cue into two lines at the space nearest its middle.
func wrap(text string) string {
	if len(text) <= lineChars {
		return text
	}
	middle := len(text) / 2
	best := -1
	for i, r := range text {
		if r == ' ' && (best < 0 || abs(i-middle) < abs(best-middle)) {
			best = i
		}
	}
	if best < 0 {
		return text
	}
	return text[:best] + "\n" + text[best+1:]
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

// WebVTT renders cues; note (e.g. subsync.DubNote) is written as a NOTE.
func WebVTT(cues []Cue, note string) string {
	var b strings.Builder
	b.WriteString("WEBVTT\n\n")
	if note != "" {
		b.WriteString("NOTE " + note + "\n\n")
	}
	for _, cue := range cues {
		fmt.Fprintf(&b, "%s --> %s\n%s\n\n", timestamp(cue.Start), timestamp(cue.End), cue.Text)
	}
	return b.String()
}

func timestamp(seconds float64) string {
	if seconds < 0 {
		seconds = 0
	}
	ms := int64(seconds*1000 + 0.5)
	return fmt.Sprintf("%02d:%02d:%02d.%03d", ms/3600000, ms/60000%60, ms/1000%60, ms%1000)
}

var (
	timingLine = regexp.MustCompile(`(?m)^.*-->.*$`)
	cueNumber  = regexp.MustCompile(`(?m)^\d+\s*$`)
	markup     = regexp.MustCompile(`<[^>]*>|\{[^}]*\}`)
	wordRx     = regexp.MustCompile(`[a-z0-9]+(?:'[a-z]+)?`)
)

func subtitleWords(text string) []string {
	text = timingLine.ReplaceAllString(text, " ")
	text = cueNumber.ReplaceAllString(text, " ")
	text = markup.ReplaceAllString(text, " ")
	text = strings.Replace(text, "WEBVTT", " ", 1)
	return wordRx.FindAllString(strings.ToLower(text), -1)
}

func bigrams(words []string) map[string]bool {
	set := make(map[string]bool, len(words))
	for i := 0; i+1 < len(words); i++ {
		set[words[i]+" "+words[i+1]] = true
	}
	return set
}

// WordMatch is the share of the transcript's word pairs a subtitle also
// has: a dub's own script shares most of them, a translation of the
// original language only a few (the same story, other words).
func WordMatch(words []Word, subtitle string) float64 {
	spoken := make([]string, 0, len(words))
	for _, word := range words {
		spoken = append(spoken, wordRx.FindAllString(strings.ToLower(word.Text), -1)...)
	}
	heard := bigrams(spoken)
	if len(heard) == 0 {
		return 0
	}
	written := bigrams(subtitleWords(subtitle))
	shared := 0
	for pair := range heard {
		if written[pair] {
			shared++
		}
	}
	return float64(shared) / float64(len(heard))
}

var nameRx = regexp.MustCompile(`^[A-Z][a-z]+(?:-[A-Z]?[a-z]+)?$`)

// Prompt names the show and the people and places its subtitles name
// (capitalised mid-sentence, at least twice), so the model writes "Saiyan"
// and "Gohan" rather than "say an" and "go on".
func Prompt(title string, subtitles []string) string {
	counts := map[string]int{}
	for _, subtitle := range subtitles {
		text := timingLine.ReplaceAllString(subtitle, " ")
		text = markup.ReplaceAllString(text, " ")
		fields := strings.Fields(text)
		for i, field := range fields {
			if i == 0 || endsSentence(fields[i-1]) || strings.HasSuffix(fields[i-1], ":") {
				continue
			}
			token := strings.Trim(field, `.,!?;:"'()…`)
			token = strings.TrimSuffix(token, "'s")
			if nameRx.MatchString(token) && token != "I" {
				counts[token]++
			}
		}
	}
	names := make([]string, 0, len(counts))
	for name, n := range counts {
		if n >= 2 {
			names = append(names, name)
		}
	}
	sort.Slice(names, func(a, b int) bool {
		if counts[names[a]] != counts[names[b]] {
			return counts[names[a]] > counts[names[b]]
		}
		return names[a] < names[b]
	})
	if len(names) > 30 {
		names = names[:30]
	}
	prompt := strings.TrimSpace(title)
	if prompt != "" {
		prompt += "."
	}
	if len(names) > 0 {
		prompt = strings.TrimSpace(prompt + " " + strings.Join(names, ", ") + ".")
	}
	return prompt
}
