package httpapi

import (
	"testing"

	"torrent-streamer/internal/subtitles"
)

func TestBestSubtitleReleasePrefersMatchingRelease(t *testing.T) {
	results := []subtitles.SubResult{
		{ID: "1", Lang: "en", Release: "Dune.Part.Two.2024.720p.WEB.H264-OTHER"},
		{ID: "2", Lang: "fr", Release: "Dune.Part.Two.2024.1080p.BluRay.x264-GROUP"},
		{ID: "3", Lang: "en", Release: "Dune.Part.Two.2024.1080p.BluRay.x264-GROUP"},
	}
	best, ok := bestSubtitleRelease(results, "en", "Dune.Part.Two.2024.1080p.BluRay.x264-GROUP.mkv")
	if !ok || best.ID != "3" {
		t.Fatalf("best = %#v ok=%v, want the matching English release", best, ok)
	}
}

func TestBestSubtitleReleaseKeepsProviderOrderOnTies(t *testing.T) {
	results := []subtitles.SubResult{
		{ID: "a", Lang: "en", Release: "Unrelated"},
		{ID: "b", Lang: "en", Release: "Also unrelated"},
	}
	best, ok := bestSubtitleRelease(results, "en", "Movie.2024.mkv")
	if !ok || best.ID != "a" {
		t.Fatalf("best = %#v, want provider's first result", best)
	}
	if _, ok := bestSubtitleRelease(results, "de", "Movie.2024.mkv"); ok {
		t.Fatalf("no German result must report not found")
	}
}
