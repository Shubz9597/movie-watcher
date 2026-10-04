package httpapi

import "testing"

func TestSortTracksByReleasePrefersTheSameRelease(t *testing.T) {
	tracks := []SubtitleTrack{
		{FileName: "Inception.2010.CAM.Xvid-LKRG.srt"},
		{FileName: "Inception.2010.720p.HDTV.x264-OTHER.srt"},
		{FileName: "Inception.2010.1080p.BluRay.x264-YIFY.srt"},
	}
	sortTracksByRelease(tracks, "Inception (2010) 1080p BrRip x264 - YIFY Inception.2010.1080p.BRrip.x264.YIFY.mp4")
	if tracks[0].FileName != "Inception.2010.1080p.BluRay.x264-YIFY.srt" {
		t.Fatalf("first = %q, want the matching YIFY 1080p subtitle", tracks[0].FileName)
	}
	if got := magnetDisplayName("magnet:?xt=urn:btih:abc&dn=Inception.2010.1080p"); got != "Inception.2010.1080p" {
		t.Fatalf("magnetDisplayName = %q", got)
	}
	unchanged := []SubtitleTrack{{FileName: "a.srt"}, {FileName: "b.srt"}}
	sortTracksByRelease(unchanged, "")
	if unchanged[0].FileName != "a.srt" {
		t.Fatal("without a video name the provider order is kept")
	}
}
