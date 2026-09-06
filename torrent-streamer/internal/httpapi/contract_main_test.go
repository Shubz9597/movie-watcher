package httpapi

import (
	"os"
	"testing"

	"torrent-streamer/internal/config"
)

// TestMain redirects the torrent data root into a temp dir and shortens the
// metadata wait for the whole test binary so characterization tests never
// write into the repository or wait 25s for unreachable peers.
func TestMain(m *testing.M) {
	tmp, err := os.MkdirTemp("", "torwatch-contract-*")
	if err != nil {
		panic(err)
	}
	os.Setenv("TORRENT_DATA_ROOT", tmp)
	os.Setenv("WAIT_METADATA_MS", "150")
	config.Load()
	code := m.Run()
	os.RemoveAll(tmp)
	os.Exit(code)
}
