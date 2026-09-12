package playback

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"sync"
	"time"
)

// sessionRunner is the testable process boundary: real runs use Runner
// (FFmpeg); unit tests inject a no-op.
type sessionRunner interface {
	Start(ctx context.Context, inputURL string, decision Decision, dir string) error
	Stop()
	Done() <-chan struct{}
	ExtractSubtitle(ctx context.Context, inputURL string, streamIndex int, outFile string) error
}

// Runner starts and supervises the FFmpeg processes of one playback session.
// All commands use argument arrays; the input is the loopback token URL
// (never a magnet); logs never echo the input URL.
type Runner struct {
	FFmpegPath string
	// mu guards the process handle for cancellation from another goroutine.
	mu      sync.Mutex
	cmd     *exec.Cmd
	running bool
	done    chan struct{}
}

// Compile-time interface check.
var _ sessionRunner = (*Runner)(nil)

// StartRemuxTranscode launches one HLS-producing FFmpeg process.
//   - copyVideo/copyAudio select stream-copy remux vs. bounded transcode.
//   - maxHeight bounds the output height (server policy).
//   - dir is the session's own directory under the configured playback root.
func (r *Runner) Start(ctx context.Context, inputURL string, decision Decision, dir string) error {
	if inputURL == "" {
		return errors.New("empty input URL")
	}
	args := []string{
		"-nostdin",
		"-loglevel", "error",
		"-y",
		"-i", inputURL,
		"-map", "0:v:0",
		"-map", "0:a:0?",
	}
	if decision.CopyVideo {
		args = append(args, "-c:v", "copy")
	} else {
		args = append(args,
			"-c:v", "libx264",
			"-preset", "veryfast",
			"-crf", "23",
			"-vf", fmt.Sprintf("scale=-2:'min(ih,%d)'", decision.MaxHeightPx),
		)
	}
	if decision.CopyAudio {
		args = append(args, "-c:a", "copy")
	} else {
		// Audio is always converted when not copied (transcode plans, and
		// remux plans whose audio codec alone is incompatible).
		args = append(args, "-c:a", "aac", "-b:a", "160k")
	}
	args = append(args,
		"-f", "hls",
		"-hls_time", "4",
		"-hls_list_size", "0",
		"-hls_segment_type", "fmp4",
		"-hls_segment_filename", dir+string(os.PathSeparator)+"seg_%05d.m4s",
		dir+string(os.PathSeparator)+"playlist.m3u8",
	)

	cmd := exec.CommandContext(ctx, r.FFmpegPath, args...)
	// Kill the WHOLE process tree on cancellation/context end.
	cmd.Cancel = func() error {
		terminateTree(cmd)
		return nil
	}
	cmd.WaitDelay = 5 * time.Second
	setSysProcAttr(cmd)

	r.mu.Lock()
	r.cmd = cmd
	r.running = true
	r.done = make(chan struct{})
	done := r.done
	r.mu.Unlock()

	if err := cmd.Start(); err != nil {
		r.mu.Lock()
		r.running = false
		r.mu.Unlock()
		close(done)
		return fmt.Errorf("ffmpeg failed to start")
	}
	go func() {
		_ = cmd.Wait()
		r.mu.Lock()
		r.running = false
		r.mu.Unlock()
		close(done)
	}()
	return nil
}

// ExtractSubtitle converts one embedded subtitle stream to a WebVTT file in
// the session directory. PGS/image formats are rejected up-front.
func (r *Runner) ExtractSubtitle(ctx context.Context, inputURL string, streamIndex int, outFile string) error {
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	args := []string{
		"-nostdin", "-loglevel", "error", "-y",
		"-i", inputURL,
		"-map", "0:" + strconv.Itoa(streamIndex),
		"-f", "webvtt",
		outFile,
	}
	cmd := exec.CommandContext(ctx, r.FFmpegPath, args...)
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("subtitle extraction failed")
	}
	return nil
}

// Stop terminates the process tree (cancellation must terminate only THIS
// session's subprocesses).
func (r *Runner) Stop() {
	r.mu.Lock()
	cmd := r.cmd
	r.mu.Unlock()
	if cmd != nil && cmd.Process != nil {
		terminateTree(cmd)
	}
}

// Done closes when the session's FFmpeg process exits. Call it only after a
// successful Start.
func (r *Runner) Done() <-chan struct{} {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.done
}

// Running reports whether a process is still alive.
func (r *Runner) Running() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.running
}

// terminateTree kills the process and its children. Windows: taskkill /T /F
// on the exact PID. Unix: negative-PID group kill (Setpgid set at start).
func terminateTree(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	if runtime.GOOS == "windows" {
		if err := exec.Command("taskkill", "/PID", strconv.Itoa(cmd.Process.Pid), "/T", "/F").Run(); err == nil {
			return
		}
		// Restricted Windows hosts can deny taskkill even for a child process.
		// Fall through to killing the exact process rather than leaking it.
	}
	terminateTreeUnix(cmd.Process.Pid)
	_ = cmd.Process.Kill()
}
