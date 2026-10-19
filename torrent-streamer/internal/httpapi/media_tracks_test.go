package httpapi

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"torrent-streamer/internal/config"
	"torrent-streamer/internal/downloads"
)

func TestMediaTracksAnswersPendingThenReady(t *testing.T) {
	release := make(chan struct{})
	var asked string
	probeTracks = func(_ context.Context, video string, _ time.Duration) (downloads.MediaTracks, error) {
		asked = video
		<-release
		return downloads.MediaTracks{Audio: []downloads.MediaTrack{{Language: "jpn", Codec: "aac"}}, Subtitles: []downloads.MediaTrack{}}, nil
	}
	t.Cleanup(func() { probeTracks = downloads.ProbeMediaTracks })
	h := SubtitleMatchHandlers{ListenAddr: ":4001"}
	ask := func() map[string]any {
		rec := httptest.NewRecorder()
		h.handleTracks(rec, httptest.NewRequest("GET", "/media/tracks?magnet=magnet:?xt=urn:btih:ABCDEF&fileIndex=3&cat=anime", nil))
		var body map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		return body
	}
	if body := ask(); body["status"] != "pending" {
		t.Fatalf("first answer = %v", body)
	}
	close(release)
	deadline := time.Now().Add(5 * time.Second)
	for {
		body := ask()
		if body["status"] == "ready" {
			audio, _ := body["audio"].([]any)
			if len(audio) != 1 {
				t.Fatalf("ready = %v", body)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("never ready: %v", body)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !strings.HasPrefix(asked, "http://127.0.0.1:4001/stream?") || !strings.Contains(asked, "fileIndex=3") {
		t.Fatalf("probed %q", asked)
	}
}

func TestMediaTracksWithoutAVideo(t *testing.T) {
	rec := httptest.NewRecorder()
	SubtitleMatchHandlers{}.handleTracks(rec, httptest.NewRequest("GET", "/media/tracks", nil))
	if !strings.Contains(rec.Body.String(), `"none"`) {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

// A download's own subtitle, read while it was prepared, answers at once
// (the server's copy of the video is gone by the time it plays).
func TestEmbeddedAnswersFromSavedTrack(t *testing.T) {
	t.Setenv("TORRENT_DATA_ROOT", t.TempDir())
	config.Load()
	if err := downloads.SaveOwnTrack("d8ac608538fb8ab3d82a31097c5d67e10e27423c", 1, 2, []byte("WEBVTT\n\n00:01.000 --> 00:02.000\nKamehameha!\n")); err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	SubtitleMatchHandlers{}.handleEmbedded(rec, httptest.NewRequest("GET",
		"/subtitles/embedded?track=2&cat=anime&fileIndex=1&magnet=magnet:?xt=urn:btih:D8AC608538FB8AB3D82A31097C5D67E10E27423C", nil))
	if !strings.Contains(rec.Body.String(), `"ready"`) {
		t.Fatalf("body = %s", rec.Body.String())
	}
}
