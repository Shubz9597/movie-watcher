//go:build !windows

package torrentx

import (
	"net"
	"os"
	"syscall"
	"testing"
)

func TestClientGoneUnixSocketErrors(t *testing.T) {
	for _, code := range []syscall.Errno{syscall.ECONNRESET, syscall.ECONNABORTED, syscall.EPIPE} {
		err := &net.OpError{Op: "write", Err: &os.SyscallError{Syscall: "write", Err: code}}
		if !ClientGone(err) {
			t.Errorf("ClientGone(%v) = false", err)
		}
	}
}
