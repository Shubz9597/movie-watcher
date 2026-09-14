package httpapi

import (
	"os"
	"testing"

	"torrent-streamer/internal/config"
)

// TestMain redirects the torrent data root into a temp dir, shortens the
// metadata wait, and gives the torrent client a RANDOM listen port for the
// whole test binary: characterization tests must not collide with a RUNNING
// staging backend that holds the library's fixed default port (42069).
func TestMain(m *testing.M) {
	tmp, err := os.MkdirTemp("", "torwatch-contract-*")
	if err != nil {
		panic(err)
	}
	os.Setenv("TORRENT_DATA_ROOT", tmp)
	os.Setenv("WAIT_METADATA_MS", "150")
	os.Setenv("TORRENT_LISTEN_PORT", "0")
	config.Load()
	code := m.Run()
	os.RemoveAll(tmp)
	os.Exit(code)
}
