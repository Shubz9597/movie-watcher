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
	ranked := rankSubtitleResults(results, "en", "Dune.Part.Two.2024.1080p.BluRay.x264-GROUP.mkv")
	if len(ranked) == 0 || ranked[0].ID != "3" {
		t.Fatalf("ranked = %#v, want the matching English release first", ranked)
	}
}

func TestBestSubtitleReleaseKeepsProviderOrderOnTies(t *testing.T) {
	results := []subtitles.SubResult{
		{ID: "a", Lang: "en", Release: "Unrelated"},
		{ID: "b", Lang: "en", Release: "Also unrelated"},
	}
	ranked := rankSubtitleResults(results, "en", "Movie.2024.mkv")
	if len(ranked) != 2 || ranked[0].ID != "a" {
		t.Fatalf("ranked = %#v, want provider's first result first", ranked)
	}
	if german := rankSubtitleResults(results, "de", "Movie.2024.mkv"); len(german) != 0 {
		t.Fatalf("no German result must report none")
	}
}

func TestRankSubtitleResultsDemotesCamTimedSubtitles(t *testing.T) {
	results := []subtitles.SubResult{
		{ID: "cam", Lang: "en", Source: "stremio", FileName: "Inception.2010.CAM.Xvid-LKRG.srt"},
		{ID: "ts", Lang: "en", Source: "stremio", FileName: "Inception.2010.TS.V2.XVID.srt"},
		{ID: "bluray", Lang: "en", Source: "opensub", Release: "Inception.2010.BluRay.720p"},
	}
	ranked := rankSubtitleResults(results, "en", "Inception (2010) 1080p BrRip x264 - YIFY")
	if ranked[0].ID != "bluray" {
		t.Fatalf("first = %s, want the non-CAM subtitle for a BluRay rip", ranked[0].ID)
	}
	camVideo := rankSubtitleResults(results, "en", "Inception.2010.CAM.Xvid-LKRG")
	if camVideo[0].ID != "cam" {
		t.Fatalf("a CAM video keeps its matching CAM subtitle first, got %s", camVideo[0].ID)
	}
}
