//go:build windows

package playback

import (
	"os/exec"
)

// On Windows, process-tree termination uses `taskkill /T /F` on the exact
// PID (see terminateTree); no SysProcAttr equivalent is required.
func setSysProcAttr(cmd *exec.Cmd) {}

// terminateTreeUnix is unreachable on Windows (terminateTree branches on
// GOOS first); defined so the package compiles for every GOOS.
func terminateTreeUnix(pid int) {}
