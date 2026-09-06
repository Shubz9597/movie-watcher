package torrentx

import (
	"errors"
	"syscall"
)

func socketDisconnected(err error) bool {
	return errors.Is(err, syscall.WSAECONNRESET) || errors.Is(err, syscall.WSAECONNABORTED)
}
