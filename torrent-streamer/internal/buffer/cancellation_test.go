package buffer

import (
	"context"
	"testing"
	"time"

	"github.com/anacrolix/torrent"
	"github.com/anacrolix/torrent/bencode"
	"github.com/anacrolix/torrent/metainfo"
)

func TestStopWarmerInterruptsMissingPieceWait(t *testing.T) {
	cfg := torrent.NewDefaultClientConfig()
	cfg.DataDir = t.TempDir()
	cfg.ListenPort = 0
	cfg.DisableUTP = true
	cfg.NoDHT = true
	cfg.DisableTrackers = true
	cfg.DisablePEX = true
	client, err := torrent.NewClient(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	raw, err := bencode.Marshal(metainfo.Info{Name: "missing.mp4", Length: 16384, PieceLength: 16384, Pieces: make([]byte, 20)})
	if err != nil {
		t.Fatal(err)
	}
	tor, err := client.AddTorrent(&metainfo.MetaInfo{InfoBytes: raw})
	if err != nil {
		t.Fatal(err)
	}
	c := &Controller{state: StatePaused, rollingBps: 3 << 20, targetAheadSec: 1}
	k := Key{Cat: "movie", IH: tor.InfoHash().HexString(), FIdx: 0}
	bufMu.Lock()
	ctrls[k] = c
	bufMu.Unlock()
	t.Cleanup(func() { bufMu.Lock(); delete(ctrls, k); bufMu.Unlock() })
	c.StartWarm(k.Cat, tor, tor.Files()[0], 0)
	// PiecePriorityNow is raised when Read starts, rather than merely when
	// the goroutine is launched. Stop an actual unavailable-piece wait.
	deadline := time.Now().Add(time.Second)
	for tor.PieceState(0).Priority != torrent.PiecePriorityNow {
		if time.Now().After(deadline) {
			t.Fatal("warmer did not begin reading")
		}
		time.Sleep(time.Millisecond)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := StopTorrent(ctx, k.Cat, k.IH); err != nil {
		t.Fatalf("stop warmer: %v", err)
	}
}
