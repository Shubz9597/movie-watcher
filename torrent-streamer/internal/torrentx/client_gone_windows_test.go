package torrentx

import (
	"net"
	"os"
	"syscall"
	"testing"
)

func TestClientGoneWindowsSocketErrors(t *testing.T) {
	for _, code := range []syscall.Errno{syscall.WSAECONNRESET, syscall.WSAECONNABORTED} {
		err := &net.OpError{Op: "write", Err: &os.SyscallError{Syscall: "write", Err: code}}
		if !ClientGone(err) {
			t.Errorf("ClientGone(%v) = false", err)
		}
	}
}
