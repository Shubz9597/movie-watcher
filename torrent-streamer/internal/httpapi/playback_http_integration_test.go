//go:build integration

package httpapi

// Full-stack HTTP integration evidence over the REAL handler surface with a
// real FFmpeg toolchain (disposable container): session create → playlist →
// segment MIME → VTT → DELETE/cleanup, plus secrets-absent and
// capability-absent checks. Mirrors the staging verifier's checks 1–9
// deterministically, without torrent peers.

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"context"
	"torrent-streamer/internal/buildinfo"
	"torrent-streamer/internal/playback"
)

type playbackHarness struct {
	server   *httptest.Server
	mux      *http.ServeMux
	mgr      *playback.Manager
	root     string
	fixtures string
	client   *http.Client
}

func bytesReader(b []byte) io.Reader { return bytes.NewReader(b) }

func newPlaybackHarness(t *testing.T) *playbackHarness {
	tools, _ := itIntegrationTools(t)
	ms, err := playback.NewMediaSource()
	if err != nil {
		t.Fatalf("media source: %v", err)
	}
	t.Cleanup(func() { ms.Close() })
	root := t.TempDir()
	fixtures := t.TempDir()
	mgr := playback.NewManager(playback.Config{
		DataRoot:            root,
		MaxActiveTranscodes: 1,
		SessionTTL:          time.Hour,
		ProbeTimeout:        30 * time.Second,
	}, tools, &playback.FFprobeProber{Tools: tools, Timeout: 30 * time.Second},
		&playback.FixtureResolver{Root: fixtures}, ms)

	h := PlaybackHandlers{Manager: mgr, Build: buildinfo.Info{SupportedProtocolRange: []int{1, 1}}, PlaybackRoot: root}
	mux := http.NewServeMux()
	h.Register(mux)
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return &playbackHarness{server: server, mux: mux, mgr: mgr, root: root, fixtures: fixtures, client: server.Client()}
}

// create posts a session and decodes the view.
func (h *playbackHarness) create(t *testing.T, cat, hexID string, fileIndex int, profile string) (playback.SessionView, int) {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"cat": cat, "sourceId": hexID, "fileIndex": fileIndex, "profile": profile})
	resp, err := h.client.Post(h.server.URL+"/v2/playback/sessions", "application/json", bytesReader(body))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	defer resp.Body.Close()
	var view playback.SessionView
	_ = json.NewDecoder(resp.Body).Decode(&view)
	return view, resp.StatusCode
}

func TestIntegrationPlaybackHTTPSurface(t *testing.T) {
	h := newPlaybackHarness(t)
	tools, _ := itIntegrationTools(t)

	// Fixtures: MP4 (direct), MKV+sidecar SRT (remux), MPEG4 (transcode).
	writeFixture := func(name string, args []string) string {
		out := filepath.Join(h.fixtures, name)
		itGenerateFixture(t, tools.FFmpegPath, args, out)
		return out
	}
	writeFixture("1111111111111111111111111111111111111111.mp4", []string{
		"-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=10",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=2",
		"-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
	})
	writeFixture("2222222222222222222222222222222222222222.mkv", []string{
		"-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=10",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=2",
		"-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
	})
	if err := os.WriteFile(filepath.Join(h.fixtures, "2222222222222222222222222222222222222222.srt"),
		[]byte("1\n00:00:00,500 --> 00:00:01,500\nHello from the fixture\n"), 0o644); err != nil {
		t.Fatalf("srt fixture: %v", err)
	}
	writeFixture("3333333333333333333333333333333333333333.mp4", []string{
		"-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=10",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=2",
		"-c:v", "mpeg4", "-c:a", "aac", "-shortest",
	})

	// 2. Compatible direct plan via HTTP.
	direct, status := h.create(t, "movie", "1111111111111111111111111111111111111111", 0, "ios-avplayer")
	if status != 201 || direct.Mode != playback.ModeDirect || direct.ReasonCode != playback.ReasonCompatible {
		t.Fatalf("direct session: status=%d mode=%s/%s", status, direct.Mode, direct.ReasonCode)
	}
	if direct.PlaybackURL == "" || strings.Contains(direct.PlaybackURL, "magnet") || direct.Info == nil {
		t.Fatalf("direct view invalid: %+v", direct)
	}
	// Media endpoint: 200 + Accept-Ranges + byte-range honored.
	mediaResp, err := h.client.Get(h.server.URL + direct.PlaybackURL)
	if err != nil {
		t.Fatalf("media get: %v", err)
	}
	io.Copy(io.Discard, mediaResp.Body)
	mediaResp.Body.Close()
	if mediaResp.StatusCode != 200 || mediaResp.Header.Get("Accept-Ranges") != "bytes" {
		t.Fatalf("media endpoint: %d %q", mediaResp.StatusCode, mediaResp.Header.Get("Accept-Ranges"))
	}
	rangeReq, _ := http.NewRequest("GET", h.server.URL+direct.PlaybackURL, nil)
	rangeReq.Header.Set("Range", "bytes=0-99")
	rangeResp, err := h.client.Do(rangeReq)
	if err != nil {
		t.Fatalf("range do: %v", err)
	}
	io.Copy(io.Discard, rangeResp.Body)
	rangeResp.Body.Close()
	if rangeResp.StatusCode != http.StatusPartialContent {
		t.Fatalf("range status = %d", rangeResp.StatusCode)
	}

	// 3+4. MKV → remux session with HLS master + segments + VTT.
	remux, status := h.create(t, "movie", "2222222222222222222222222222222222222222", 0, "ios-avplayer")
	if status != 201 || remux.Mode != playback.ModeRemux {
		t.Fatalf("remux session: status=%d mode=%s (%s)", status, remux.Mode, remux.ReasonCode)
	}
	masterURL := h.server.URL + remux.PlaybackURL
	masterResp, err := h.client.Get(masterURL)
	if err != nil {
		t.Fatalf("master get: %v", err)
	}
	masterBody, _ := io.ReadAll(masterResp.Body)
	masterResp.Body.Close()
	if masterResp.StatusCode != 200 || masterResp.Header.Get("Content-Type") != "application/vnd.apple.mpegurl" {
		t.Fatalf("master: %d %q", masterResp.StatusCode, masterResp.Header.Get("Content-Type"))
	}
	masterText := string(masterBody)
	if !strings.Contains(masterText, "#EXT-X-STREAM-INF") || strings.Contains(masterText, "magnet") || strings.Contains(masterText, "2222222222") {
		t.Fatalf("master playlist invalid or leaking:\n%s", masterText)
	}
	// Variant playlist reachable through the traversal-protected /hls/ path.

	itWaitForFile(t, filepath.Join(h.root, remux.SessionID, "playlist.m3u8"), 45*time.Second)
	variantPath := "hls/playlist.m3u8"
	variantResp, err := h.client.Get(h.server.URL + "/v2/playback/sessions/" + remux.SessionID + "/" + variantPath)
	if err != nil {
		t.Fatalf("variant get: %v", err)
	}
	variantBody, _ := io.ReadAll(variantResp.Body)
	variantResp.Body.Close()
	if variantResp.StatusCode != 200 || !strings.Contains(string(variantBody), "#EXTINF") {
		t.Fatalf("variant playlist: %d %q", variantResp.StatusCode, string(variantBody)[:min(80, len(variantBody))])
	}
	// At least one segment with the fMP4 MIME type.
	var segmentName string
	for _, line := range strings.Split(string(variantBody), "\n") {
		line = strings.TrimSpace(line)
		if line != "" && !strings.HasPrefix(line, "#") {
			segmentName = line
			break
		}
	}
	if segmentName == "" {
		t.Fatal("variant playlist lists no segments")
	}
	segResp, err := h.client.Get(h.server.URL + "/v2/playback/sessions/" + remux.SessionID + "/hls/" + segmentName)
	if err != nil {
		t.Fatalf("segment get: %v", err)
	}
	io.Copy(io.Discard, segResp.Body)
	segResp.Body.Close()
	if segResp.StatusCode != 200 || segResp.Header.Get("Content-Type") != "video/mp4" {
		t.Fatalf("segment: %d %q", segResp.StatusCode, segResp.Header.Get("Content-Type"))
	}
	// 7. Sidecar SRT became a valid WebVTT offer.
	if len(remux.Subtitles) != 1 {
		t.Fatalf("subtitle offers = %d, want 1", len(remux.Subtitles))
	}
	subResp, err := h.client.Get(h.server.URL + remux.Subtitles[0].URL)
	if err != nil {
		t.Fatalf("vtt get: %v", err)
	}
	subBody, _ := io.ReadAll(subResp.Body)
	subResp.Body.Close()
	if subResp.StatusCode != 200 || subResp.Header.Get("Content-Type") == "" ||
		!strings.HasPrefix(string(subBody), "WEBVTT") ||
		strings.Contains(string(subBody), "00:00:00,500") {
		t.Fatalf("vtt: %d %q url=%q", subResp.StatusCode, string(subBody[:min(80, len(subBody))]), remux.Subtitles[0].URL)
	}
	// Traversal through the hls/ path is refused.
	travResp, err := h.client.Get(h.server.URL + "/v2/playback/sessions/" + remux.SessionID + "/hls/..%2f..%2fesccape.m3u8")
	if err == nil {
		io.Copy(io.Discard, travResp.Body)
		travResp.Body.Close()
		if travResp.StatusCode == 200 {
			t.Fatal("traversal request was served")
		}
	}

	// 4b. Incompatible codec → transcode plan over HTTP.
	reqDel, _ := http.NewRequest("DELETE", h.server.URL+"/v2/playback/sessions/"+remux.SessionID, nil)
	delResp2, err := h.client.Do(reqDel)
	if err != nil {
		t.Fatalf("remux delete: %v", err)
	}
	delResp2.Body.Close()
	transcode, status := h.create(t, "movie", "3333333333333333333333333333333333333333", 0, "ios-avplayer")
	if status != 201 || transcode.Mode != playback.ModeTranscode {
		t.Fatalf("transcode session: status=%d mode=%s (%s)", status, transcode.Mode, transcode.ReasonCode)
	}
	itWaitForFile(t, filepath.Join(h.root, transcode.SessionID, "playlist.m3u8"), 45*time.Second)

	// 8. DELETE removes the session and its directory; subsequent access 404s.
	req, _ := http.NewRequest("DELETE", h.server.URL+"/v2/playback/sessions/"+remux.SessionID, nil)
	delResp, err := h.client.Do(req)
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	delResp.Body.Close()
	if delResp.StatusCode != 204 {
		t.Fatalf("delete status = %d", delResp.StatusCode)
	}
	if _, err := os.Stat(filepath.Join(h.root, remux.SessionID)); !os.IsNotExist(err) {
		t.Fatal("session directory survived DELETE")
	}
	getResp, err := h.client.Get(h.server.URL + "/v2/playback/sessions/" + remux.SessionID)
	if err != nil {
		t.Fatalf("get after delete: %v", err)
	}
	getResp.Body.Close()
	if getResp.StatusCode != 404 {
		t.Fatalf("get after delete status = %d", getResp.StatusCode)
	}
	// Delete the remaining sessions so cleanup assertions are deterministic.
	for _, id := range []string{direct.SessionID, transcode.SessionID} {
		req, _ := http.NewRequest("DELETE", h.server.URL+"/v2/playback/sessions/"+id, nil)
		resp, err := h.client.Do(req)
		if err == nil {
			resp.Body.Close()
		}
	}
}

func itIntegrationTools(t *testing.T) (playback.Tools, string) {
	t.Helper()
	if os.Getenv("TORWATCH_PLAYBACK_INTEGRATION") != "1" {
		t.Skip("integration evidence requires TORWATCH_PLAYBACK_INTEGRATION=1")
	}
	tools := playback.Tools{FFprobePath: "ffprobe", FFmpegPath: "ffmpeg"}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if ok, why := tools.Available(ctx); !ok {
		t.Skipf("ffmpeg toolchain unavailable: %s", why)
	}
	return tools, t.TempDir()
}
func itGenerateFixture(t *testing.T, ffmpeg string, args []string, out string) string {
	t.Helper()
	cmd := exec.Command(ffmpeg, append(append([]string{"-nostdin", "-loglevel", "error", "-y"}, args...), out)...)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("fixture generation failed (%s): %v: %s", out, err, string(output))
	}
	if _, err := os.Stat(out); err != nil {
		t.Fatalf("fixture missing: %v", err)
	}
	return out
}
func itWaitForFile(t *testing.T, path string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if info, err := os.Stat(path); err == nil && info.Size() > 0 {
			return
		}
		time.Sleep(250 * time.Millisecond)
	}
	t.Fatalf("file never appeared: %s", path)
}
