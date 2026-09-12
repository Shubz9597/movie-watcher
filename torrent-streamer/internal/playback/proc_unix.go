//go:build !windows

package playback

import (
	"os/exec"
	"syscall"
)

// setSysProcAttr puts unix children in their own process group so the whole
// tree can be killed on cancellation.
func setSysProcAttr(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// terminateTreeUnix kills the child's whole process group.
func terminateTreeUnix(pid int) {
	_ = syscall.Kill(-pid, syscall.SIGKILL)
}
