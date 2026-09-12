package playback

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeResolver implements Resolver with in-memory readers. Each Resolve
// publishes the prober result the session-under-test should observe (the
// prober only ever sees the opaque loopback URL, never the source).
type fakeResolver struct {
	probeFor map[string]*MediaInfo // keyed by source ID
	current  *sharedProbeState
	sources  map[string]ResolvedSource
	err      error
}

type sharedProbeState struct {
	mu   sync.Mutex
	info *MediaInfo
}

func (s *sharedProbeState) set(info *MediaInfo) {
	s.mu.Lock()
	s.info = info
	s.mu.Unlock()
}

func (s *sharedProbeState) get() *MediaInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.info == nil {
		return nil
	}
	cp := *s.info
	return &cp
}

type sharedProber struct{ state *sharedProbeState }

func (f *sharedProber) Probe(_ context.Context, _ string) (*MediaInfo, error) {
	if info := f.state.get(); info != nil {
		return info, nil
	}
	return nil, &Error{Code: ReasonMediaInspectionFail, Message: "probe failed"}
}

func (f *fakeResolver) Resolve(_ context.Context, _, sourceID string, _ int) (ResolvedSource, error) {
	if f.err != nil {
		return ResolvedSource{}, f.err
	}
	src, ok := f.sources[sourceID]
	if !ok {
		return ResolvedSource{}, &Error{Code: ReasonMalformedSource, Message: "The source could not be opened."}
	}
	if f.current != nil && f.probeFor != nil {
		f.current.set(f.probeFor[sourceID])
	}
	return src, nil
}

type fakeRunner struct {
	started chan string
	closed  chan struct{}
}

// fakeSessionRunner records starts without launching any process.
type fakeSessionRunner struct {
	started  int
	stopped  int
	done     chan struct{}
	doneOnce sync.Once
}

func (f *fakeSessionRunner) Start(_ context.Context, _ string, _ Decision, _ string) error {
	f.started++
	f.done = make(chan struct{})
	return nil
}
func (f *fakeSessionRunner) Stop() {
	f.stopped++
	f.complete()
}
func (f *fakeSessionRunner) Done() <-chan struct{} { return f.done }
func (f *fakeSessionRunner) ExtractSubtitle(context.Context, string, int, string) error {
	return nil
}

func (f *fakeSessionRunner) complete() {
	if f.done != nil {
		f.doneOnce.Do(func() { close(f.done) })
	}
}

func newTestManager(t *testing.T, prober Prober, resolver Resolver) *Manager {
	t.Helper()
	ms, err := NewMediaSource()
	if err != nil {
		t.Skipf("loopback listener unavailable: %v", err)
	}
	t.Cleanup(func() { ms.Close() })
	root := t.TempDir()
	m := NewManager(Config{
		DataRoot:            root,
		MaxActiveTranscodes: 1,
		SessionTTL:          50 * time.Millisecond,
		ProbeTimeout:        time.Second,
		MaxSessions:         4,
	}, Tools{FFmpegPath: "ffmpeg-fake", FFprobePath: "ffprobe-fake"}, prober, resolver, ms)
	m.newRunner = func() sessionRunner { return &fakeSessionRunner{} }
	return m
}

func mkvSource(marker string) ResolvedSource {
	return ResolvedSource{
		Open: openFake(2048),
		Name: "sample.mkv",
		Size: 2048,
		Sidecars: []Sidecar{{
			Format:   "srt",
			Language: "en",
			Label:    "English.srt",
			Open: func() (io.ReadCloser, error) {
				return io.NopCloser(strings.NewReader("1\n00:00:01,000 --> 00:00:02,000\nHello\n")), nil
			},
		}},
	}
}

// 7/8. Session IDs are opaque; NO magnet appears in views, URLs, or errors.
func TestCreateSessionOpaqueIDsNoMagnet(t *testing.T) {
	state := &sharedProbeState{}
	resolver := &fakeResolver{sources: map[string]ResolvedSource{
		"0123456789abcdef0123456789abcdef01234567": mkvSource("m1"),
	}, probeFor: map[string]*MediaInfo{"0123456789abcdef0123456789abcdef01234567": mkvH264AAC()}, current: state}
	m := newTestManager(t, &sharedProber{state}, resolver)

	view, err := m.Create(context.Background(), "movie", "0123456789abcdef0123456789abcdef01234567", 0, "ios-avplayer")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	encoded := fmt.Sprintf("%+v", view)
	if strings.Contains(encoded, "magnet") || strings.Contains(encoded, "0123456789abcdef") {
		t.Fatalf("session view leaks source material: %s", encoded)
	}
	if len(view.SessionID) != 64 || view.SessionID == "" {
		t.Fatalf("session id = %q", view.SessionID)
	}
	if view.Mode != ModeRemux {
		t.Fatalf("mode = %s", view.Mode)
	}
	if view.PlaybackURL == "" || strings.Contains(view.PlaybackURL, "magnet") {
		t.Fatalf("playback URL leaks: %s", view.PlaybackURL)
	}
}

// Invalid profile/source → bounded errors, no panic, no magnet echo.
func TestCreateValidationIsBounded(t *testing.T) {
	resolver := &fakeResolver{err: &Error{Code: "invalid_request", Message: "The source identifier must be a 40-character info hash."}}
	m := newTestManager(t, &sharedProber{&sharedProbeState{}}, resolver)

	if _, err := m.Create(context.Background(), "movie", "x", 0, "unknown-profile"); err == nil {
		t.Fatal("unknown profile must fail")
	}
	_, err := m.Create(context.Background(), "movie", "short", 0, "ios-avplayer")
	if err == nil || !strings.Contains(err.Error(), "40-character") || strings.Contains(err.Error(), "magnet") {
		t.Fatalf("bounded validation error expected, got %v", err)
	}
}

// 10. Max-transcode concurrency (default 1) returns a truthful capacity error.
func TestTranscodeConcurrencyIsBounded(t *testing.T) {
	state := &sharedProbeState{}
	resolver := &fakeResolver{sources: map[string]ResolvedSource{
		"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": mkvSource("m1"),
		"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": mkvSource("m2"),
	}, probeFor: map[string]*MediaInfo{
		"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": mkvMpeg4Video(),
		"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": mkvMpeg4Video(),
	}, current: state}
	m := newTestManager(t, &sharedProber{state}, resolver)

	first, err := m.Create(context.Background(), "movie", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 0, "ios-avplayer")
	if err != nil {
		t.Fatalf("first transcode: %v", err)
	}
	second, err := m.Create(context.Background(), "movie", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", 0, "ios-avplayer")
	if err == nil {
		t.Fatalf("second concurrent transcode must hit the capacity bound (got session %s)", second.SessionID)
	}
	if !strings.Contains(err.Error(), "converting another source") {
		t.Fatalf("capacity error = %v", err)
	}
	// Free the slot: the first session ends, the next one is admitted.
	m.Delete(first.SessionID)
	third, err := m.Create(context.Background(), "movie", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", 0, "ios-avplayer")
	if err != nil {
		t.Fatalf("transcode after delete: %v", err)
	}
	m.Delete(third.SessionID)
}

func TestCompletedConversionReleasesCapacity(t *testing.T) {
	state := &sharedProbeState{}
	resolver := &fakeResolver{sources: map[string]ResolvedSource{
		"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": mkvSource("m1"),
		"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": mkvSource("m2"),
	}, probeFor: map[string]*MediaInfo{
		"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": mkvMpeg4Video(),
		"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": mkvMpeg4Video(),
	}, current: state}
	m := newTestManager(t, &sharedProber{state}, resolver)
	var runners []*fakeSessionRunner
	m.newRunner = func() sessionRunner {
		runner := &fakeSessionRunner{}
		runners = append(runners, runner)
		return runner
	}

	first, err := m.Create(context.Background(), "movie", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 0, "ios-avplayer")
	if err != nil {
		t.Fatalf("first conversion: %v", err)
	}
	runners[0].complete()
	deadline := time.Now().Add(time.Second)
	for len(m.transcodes) != 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if len(m.transcodes) != 0 {
		t.Fatal("completed conversion kept the active-conversion slot")
	}
	second, err := m.Create(context.Background(), "movie", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", 0, "ios-avplayer")
	if err != nil {
		t.Fatalf("conversion after process completion: %v", err)
	}
	m.Delete(first.SessionID)
	m.Delete(second.SessionID)
}

func TestDirectSessionDeleteRemovesCreatedDirectory(t *testing.T) {
	state := &sharedProbeState{}
	sourceID := "dddddddddddddddddddddddddddddddddddddddd"
	resolver := &fakeResolver{sources: map[string]ResolvedSource{
		sourceID: {
			Open: openFake(2048), Name: "sample.mp4", Size: 2048,
			Sidecars: []Sidecar{{Format: "srt", Open: func() (io.ReadCloser, error) {
				return io.NopCloser(strings.NewReader("1\n00:00:01,000 --> 00:00:02,000\nHello\n")), nil
			}}},
		},
	}, probeFor: map[string]*MediaInfo{sourceID: mp4H264AAC()}, current: state}
	m := newTestManager(t, &sharedProber{state}, resolver)

	view, err := m.Create(context.Background(), "movie", sourceID, 0, "ios-avplayer")
	if err != nil {
		t.Fatalf("create direct session: %v", err)
	}
	dir := filepath.Join(m.cfg.DataRoot, view.SessionID)
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("session directory missing before delete: %v", err)
	}
	m.Delete(view.SessionID)
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("direct session directory survived delete: %v", err)
	}
}

type barrierResolver struct {
	source  ResolvedSource
	entered chan struct{}
	release <-chan struct{}
}

func (r *barrierResolver) Resolve(context.Context, string, string, int) (ResolvedSource, error) {
	r.entered <- struct{}{}
	<-r.release
	return r.source, nil
}

type fixedProber struct{ info *MediaInfo }

func (p fixedProber) Probe(context.Context, string) (*MediaInfo, error) {
	copy := *p.info
	return &copy, nil
}

func TestConcurrentCreatesRespectSessionLimit(t *testing.T) {
	const attempts = 12
	release := make(chan struct{})
	resolver := &barrierResolver{
		source:  ResolvedSource{Open: openFake(2048), Name: "sample.mp4", Size: 2048},
		entered: make(chan struct{}, attempts),
		release: release,
	}
	m := newTestManager(t, fixedProber{mp4H264AAC()}, resolver)
	m.cfg.MaxSessions = 2

	results := make(chan error, attempts)
	for range attempts {
		go func() {
			_, err := m.Create(context.Background(), "movie", "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", 0, "ios-avplayer")
			results <- err
		}()
	}
	for range attempts {
		<-resolver.entered
	}
	close(release)
	successes := 0
	for range attempts {
		if err := <-results; err == nil {
			successes++
		}
	}
	if successes != m.cfg.MaxSessions {
		t.Fatalf("successful concurrent creates = %d, want %d", successes, m.cfg.MaxSessions)
	}
	m.Stop()
}

func TestCreateCannotPublishAfterStop(t *testing.T) {
	release := make(chan struct{})
	resolver := &barrierResolver{
		source:  ResolvedSource{Open: openFake(2048), Name: "sample.mp4", Size: 2048},
		entered: make(chan struct{}, 1),
		release: release,
	}
	m := newTestManager(t, fixedProber{mp4H264AAC()}, resolver)
	result := make(chan error, 1)
	go func() {
		_, err := m.Create(context.Background(), "movie", "ffffffffffffffffffffffffffffffffffffffff", 0, "ios-avplayer")
		result <- err
	}()
	<-resolver.entered
	m.Stop()
	close(release)
	if err := <-result; err == nil || !strings.Contains(err.Error(), "stopping") {
		t.Fatalf("create racing Stop returned %v", err)
	}
	if len(m.sessions) != 0 {
		t.Fatalf("stopped manager published %d sessions", len(m.sessions))
	}
}

func TestMasterPlaylistDescribesTranscodedOutput(t *testing.T) {
	info := mkvMpeg4Video()
	info.Audio.Codec = "opus"
	info.Width, info.Height = 3840, 2160
	sess := &session{
		decision: Decision{Mode: ModeTranscode, CopyVideo: false, CopyAudio: false, MaxHeightPx: 1080},
		view:     SessionView{Info: info},
	}
	master := WriteMasterPlaylist(sess)
	if !strings.Contains(master, `CODECS="avc1.640028,mp4a.40.2"`) {
		t.Fatalf("master does not describe transcoded codecs: %s", master)
	}
	if !strings.Contains(master, "RESOLUTION=1920x1080") {
		t.Fatalf("master does not describe scaled output: %s", master)
	}
	if strings.Contains(master, "mpeg4") || strings.Contains(master, "opus") || strings.Contains(master, "3840x2160") {
		t.Fatalf("master leaked source rendition metadata: %s", master)
	}
}

// 12. TTL cleanup removes ONLY the session's own directory (root-constrained).
func TestTTLCleanupConstrainedToRoot(t *testing.T) {
	state := &sharedProbeState{}
	resolver := &fakeResolver{sources: map[string]ResolvedSource{
		"cccccccccccccccccccccccccccccccccccccccc": mkvSource("m1"),
	}, probeFor: map[string]*MediaInfo{"cccccccccccccccccccccccccccccccccccccccc": mkvH264AAC()}, current: state}
	m := newTestManager(t, &sharedProber{state}, resolver)

	view, err := m.Create(context.Background(), "movie", "cccccccccccccccccccccccccccccccccccccccc", 0, "ios-avplayer")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	sessDir := filepath.Join(m.cfg.DataRoot, view.SessionID)
	if _, err := os.Stat(sessDir); err != nil {
		t.Fatalf("session dir missing: %v", err)
	}
	// A neighboring directory that must NEVER be touched.
	neighbor := filepath.Join(m.cfg.DataRoot, "unrelated-neighbor")
	if err := os.Mkdir(neighbor, 0o755); err != nil {
		t.Fatalf("neighbor: %v", err)
	}

	// The data root boundary is enforced: a session ID with traversal is
	// rejected by the same safeJoin used for serving.
	if _, err := safeJoin(m.cfg.DataRoot, "../escape"); err == nil {
		t.Fatal("traversal must be rejected")
	}
	if _, err := safeJoin(m.cfg.DataRoot, "ok/../also-ok"); err != nil {
		t.Fatalf("benign relative path rejected: %v", err)
	}

	// Let the TTL pass, sweep, and confirm ONLY the session dir was removed.
	time.Sleep(80 * time.Millisecond)
	removed := m.CleanupSweeper()
	if len(removed) != 1 || removed[0] != view.SessionID {
		t.Fatalf("sweeper removed %v", removed)
	}
	if _, err := os.Stat(sessDir); !os.IsNotExist(err) {
		t.Fatalf("session dir still present: %v", err)
	}
	if _, err := os.Stat(neighbor); err != nil {
		t.Fatalf("neighbor directory was deleted: %v", err)
	}
}

// Removal refuses directories that are not direct children of the root.
func TestRemoveSessionDirRefusesOutsideRoot(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	marker := filepath.Join(outside, "keep.txt")
	if err := os.WriteFile(marker, []byte("keep"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	removeSessionDir(root, outside) // not a direct child of root → refused
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("removeSessionDir deleted outside the configured root")
	}
}

// Stale-session startup sweep is deterministic: any directory under the root
// is stale because the in-memory registry starts empty.
func TestSweepStaleAtStartupRemovesOnlyRootChildren(t *testing.T) {
	resolver := &fakeResolver{sources: map[string]ResolvedSource{}}
	m := newTestManager(t, &sharedProber{&sharedProbeState{}}, resolver)
	stale := filepath.Join(m.cfg.DataRoot, "stale-session-dir")
	if err := os.MkdirAll(stale, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	m.SweepStaleAtStartup()
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatal("stale session dir survived the startup sweep")
	}
}

// Cancellation terminates a real long-lived subprocess quickly (case 11).
func TestTerminateTreeKillsProcess(t *testing.T) {
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("cmd", "/c", "ping -n 30 127.0.0.1 > NUL")
	} else {
		cmd = exec.Command("sleep", "30")
	}
	setSysProcAttr(cmd)
	if err := cmd.Start(); err != nil {
		t.Skipf("could not start test subprocess: %v", err)
	}
	done := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		close(done)
	}()
	started := time.Now()
	terminateTree(cmd)
	select {
	case <-done:
		if elapsed := time.Since(started); elapsed > 10*time.Second {
			t.Fatalf("terminateTree took %s", elapsed)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("subprocess survived terminateTree")
	}
}
