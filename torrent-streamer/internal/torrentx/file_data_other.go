//go:build !unix

package torrentx

// allocatedBytes is unknown off unix; EnsureFileData then does nothing.
func allocatedBytes(string) int64 { return -1 }
