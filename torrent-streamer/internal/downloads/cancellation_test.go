package downloads

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/anacrolix/torrent"
	"github.com/anacrolix/torrent/bencode"
	"github.com/anacrolix/torrent/metainfo"
)

func TestPreparationCopyCancelsMissingPieceWait(t *testing.T) {
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
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	p := &Prepper{}
	done := make(chan error, 1)
	go func() {
		_, _, err := p.copyTo(ctx, tor.Files()[0], filepath.Join(cfg.DataDir, "prepared.mp4"))
		done <- err
	}()
	select {
	case err := <-done:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("copy error=%v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("preparation slot remained blocked after timeout")
	}
}
