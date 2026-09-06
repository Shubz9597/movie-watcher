package torrentx

import (
	"context"
	"errors"
	"fmt"
	"net"
	"testing"
)

func TestClientGone(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"canceled", fmt.Errorf("stream: %w", context.Canceled), true},
		{"closed", &net.OpError{Op: "write", Err: net.ErrClosed}, true},
		{"unrelated", errors.New("disk failure"), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := ClientGone(tc.err); got != tc.want {
				t.Errorf("ClientGone(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}
