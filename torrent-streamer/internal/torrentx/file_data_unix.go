//go:build unix

package torrentx

import (
	"os"
	"syscall"
)

// allocatedBytes is the data a file really holds on disk (sparse files hold
// less than their size); 0 when it does not exist, -1 when unknown.
func allocatedBytes(path string) int64 {
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return 0
		}
		return -1
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok {
		return int64(stat.Blocks) * 512
	}
	return -1
}
