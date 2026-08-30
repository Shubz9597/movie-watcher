package torrentx

import "testing"

func TestSubtitleMatchesSelectedEpisodeInPack(t *testing.T) {
	video := "Show/Show.S01E02.1080p.mkv"
	cases := []struct {
		path string
		want bool
	}{
		{"Show/Show.S01E02.1080p.en.srt", true},
		{"Show/Subs/S01E02/English.ass", true},
		{"Show/Show.S01E03.1080p.en.srt", false},
		{"Show/Subs/S01E08/English.srt", false},
		{"Show/Subs/English.srt", false},
	}
	for _, tc := range cases {
		if got := subtitleMatchesVideoPath(tc.path, video, 8); got != tc.want {
			t.Fatalf("subtitleMatchesVideoPath(%q) = %v, want %v", tc.path, got, tc.want)
		}
	}
}

func TestSubtitleMatchesGenericNameForSingleVideo(t *testing.T) {
	if !subtitleMatchesVideoPath("Movie/Subs/English.srt", "Movie/Movie.2026.mkv", 1) {
		t.Fatal("a single-video torrent should accept a generic included subtitle")
	}
}
