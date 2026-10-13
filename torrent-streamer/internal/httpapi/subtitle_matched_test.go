package httpapi

import (
	"context"
	"net/url"
	"testing"
	"time"

	"torrent-streamer/internal/downloads"
)

func TestMatchKeyIgnoresTrackersAndNames(t *testing.T) {
	a := matchSource{magnet: "magnet:?xt=urn:btih:3185E40C96DDFCF57DEEC617922038DA7C193B01&dn=Kai&tr=udp%3A%2F%2Fa", fileIndex: 38}
	b := matchSource{magnet: "magnet:?xt=urn:btih:3185e40c96ddfcf57deec617922038da7c193b01&tr=udp%3A%2F%2Fb", fileIndex: 38}
	if matchKey(a, "en") != matchKey(b, "en") {
		t.Fatal("one video measured twice")
	}
	if matchKey(a, "en") == matchKey(matchSource{magnet: a.magnet, fileIndex: 39}, "en") || matchKey(a, "en") == matchKey(a, "es") {
		t.Fatal("different episodes or languages share a result")
	}
}

func TestResolveStreamBuildsTheSubtitleSearch(t *testing.T) {
	q := url.Values{
		"magnet": {"magnet:?xt=urn:btih:abc&dn=%5BAnimeRG%5D+Dragon+Ball+KAI"}, "fileIndex": {"38"}, "cat": {"anime"},
		"anilistId": {"6033"}, "season": {"1"}, "episode": {"20"}, "imdbId": {"tt1409055"}, "title": {"Dragon Ball Z Kai"},
	}
	source, err := SubtitleMatchHandlers{}.resolve(context.Background(), q, "en")
	if err != nil {
		t.Fatal(err)
	}
	if source.fileIndex != 38 || source.cat != "anime" || source.query.SeriesID != "anilist:6033" ||
		source.query.Episode != 20 || source.query.Hints.IMDBID != "tt1409055" || source.query.Lang != "en" {
		t.Fatalf("source = %+v", source)
	}
	if _, err := (SubtitleMatchHandlers{}).resolve(context.Background(), url.Values{"cat": {"tv"}}, "en"); err == nil {
		t.Fatal("a request without a video was accepted")
	}
}

func TestMatchResponses(t *testing.T) {
	pending := &matchEntry{done: make(chan struct{}), lang: "en"}
	if got := pending.response("k"); got["status"] != "pending" {
		t.Fatalf("pending = %v", got)
	}
	ready := &matchEntry{done: make(chan struct{}), lang: "en", status: "ready", at: time.Now(),
		matched: downloads.Matched{Dub: true, Offset: -4, Fit: 0.54}}
	close(ready.done)
	got := ready.response("k")
	if got["status"] != "ready" || got["dub"] != true || got["offset"] != -4.0 || got["url"] != "/subtitles/matched/file?key=k" {
		t.Fatalf("ready = %v", got)
	}
	none := &matchEntry{done: make(chan struct{}), lang: "en", status: "none"}
	close(none.done)
	if got := none.response("k"); got["status"] != "none" || got["url"] != nil {
		t.Fatalf("none = %v", got)
	}
}
