package downloads

import "testing"

func TestSubtitleHintsValid(t *testing.T) {
	valid := []SubtitleHints{
		{},
		{Title: "Dune: Part Two", Year: 2024, IMDBID: "tt15239678"},
		{Title: "Frieren: Beyond Journey's End"},
	}
	for _, h := range valid {
		if !h.Valid() {
			t.Fatalf("hints %#v should be valid", h)
		}
	}
	invalid := []SubtitleHints{
		{IMDBID: "15239678"},
		{IMDBID: "tt12ab"},
		{Year: 1200},
		{Title: "line\nbreak"},
		{Title: string(make([]byte, 301))},
	}
	for _, h := range invalid {
		if h.Valid() {
			t.Fatalf("hints %#v should be rejected", h)
		}
	}
}
