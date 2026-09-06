//go:build !windows

package torrentx

import (
	"errors"
	"syscall"
)

func socketDisconnected(err error) bool {
	return errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.ECONNABORTED) || errors.Is(err, syscall.EPIPE)
}
