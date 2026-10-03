package torrentx

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/anacrolix/torrent"
	"github.com/anacrolix/torrent/bencode"
	"github.com/anacrolix/torrent/metainfo"
	"torrent-streamer/internal/config"
)

func TestCategoryClientsUseDistinctDefaultPorts(t *testing.T) {
	CloseAllClients()
	t.Cleanup(CloseAllClients)
	t.Setenv("TORRENT_DATA_ROOT", t.TempDir())
	t.Setenv("TORRENT_LISTEN_PORT", "")
	config.Load()
	ports := map[int]bool{}
	for _, category := range []string{"movie", "tv", "anime", "misc"} {
		client, err := GetClientFor(category)
		if err != nil {
			t.Fatal(err)
		}
		port := client.ListenAddrs()[0].(*net.TCPAddr).Port
		if port == 0 || ports[port] {
			t.Fatalf("category %s reused port %d", category, port)
		}
		ports[port] = true
	}
}

func TestClientInitializationFailureReturnsError(t *testing.T) {
	CloseAllClients()
	t.Cleanup(CloseAllClients)
	l, err := net.Listen("tcp", ":0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	port := l.Addr().(*net.TCPAddr).Port
	if port > 65532 {
		t.Skip("ephemeral port outside allowed base range")
	}
	t.Setenv("TORRENT_DATA_ROOT", t.TempDir())
	t.Setenv("TORRENT_LISTEN_PORT", strconv.Itoa(port))
	config.Load()
	if _, err := GetClientFor("movie"); err == nil {
		t.Fatal("occupied port accepted")
	}
	t.Setenv("TORRENT_LISTEN_PORT", "0")
	if _, err := GetClientFor("movie"); err != nil {
		t.Fatalf("failed initialization could not be retried: %v", err)
	}
}

func TestConfiguredCategoryPortsUseConsecutiveOffsets(t *testing.T) {
	CloseAllClients()
	t.Cleanup(CloseAllClients)
	first, err := net.Listen("tcp", ":0")
	if err != nil {
		t.Fatal(err)
	}
	base := first.Addr().(*net.TCPAddr).Port
	listeners := []net.Listener{first}
	defer func() {
		for _, l := range listeners {
			l.Close()
		}
	}()
	if base > 65532 {
		t.Skip("base outside allowed range")
	}
	for offset := 1; offset < 4; offset++ {
		l, err := net.Listen("tcp", ":"+strconv.Itoa(base+offset))
		if err != nil {
			t.Skip("four consecutive free test ports unavailable")
		}
		listeners = append(listeners, l)
	}
	for _, l := range listeners {
		l.Close()
	}
	t.Setenv("TORRENT_DATA_ROOT", t.TempDir())
	t.Setenv("TORRENT_LISTEN_PORT", strconv.Itoa(base))
	config.Load()
	for offset, category := range []string{"movie", "tv", "anime", "misc"} {
		client, err := GetClientFor(category)
		if err != nil {
			t.Fatal(err)
		}
		if got := client.ListenAddrs()[0].(*net.TCPAddr).Port; got != base+offset {
			t.Fatalf("%s port=%d, want %d", category, got, base+offset)
		}
	}
}

func missingPieceReader(t *testing.T) torrent.Reader {
	t.Helper()
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
	t.Cleanup(func() { client.Close() })
	raw, err := bencode.Marshal(metainfo.Info{Name: "missing.mp4", Length: 16384, PieceLength: 16384, Pieces: make([]byte, 20)})
	if err != nil {
		t.Fatal(err)
	}
	tor, err := client.AddTorrent(&metainfo.MetaInfo{InfoBytes: raw})
	if err != nil {
		t.Fatal(err)
	}
	reader := tor.Files()[0].NewReader()
	t.Cleanup(func() { reader.Close() })
	return reader
}

func TestPrebufferMissingPieceHonorsDeadline(t *testing.T) {
	reader := missingPieceReader(t)
	done := make(chan int64, 1)
	go func() { done <- Prebuffer(context.Background(), reader, 1, 50*time.Millisecond) }()
	select {
	case got := <-done:
		if got != 0 {
			t.Fatalf("read %d unavailable bytes", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("prebuffer deadline did not interrupt piece wait")
	}
}

func TestMissingPieceReaderHonorsCancellation(t *testing.T) {
	reader := missingPieceReader(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	reader.SetContext(ctx)
	done := make(chan error, 1)
	go func() { _, err := reader.Read(make([]byte, 1)); done <- err }()
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("read error = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cancel did not interrupt piece wait")
	}
}

func TestDownloadSourceManifestAllowsSafeReclamation(t *testing.T) {
	CloseAllClients()
	t.Cleanup(CloseAllClients)
	root := t.TempDir()
	t.Setenv("TORRENT_DATA_ROOT", root)
	t.Setenv("TORRENT_LISTEN_PORT", "0")
	t.Setenv("WATCH_DROP_GUARD", "0s")
	config.Load()
	client, err := GetClientFor("movie")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := bencode.Marshal(metainfo.Info{Name: "offline-only.mp4", Length: 16384, PieceLength: 16384, Pieces: make([]byte, 20)})
	if err != nil {
		t.Fatal(err)
	}
	tor, err := client.AddTorrent(&metainfo.MetaInfo{InfoBytes: raw})
	if err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(root, "movie", "offline-only.mp4")
	if err := os.WriteFile(source, make([]byte, 16384), 0600); err != nil {
		t.Fatal(err)
	}
	prepared := filepath.Join(root, "downloads", "ready", "job", "video.mp4")
	if err := os.MkdirAll(filepath.Dir(prepared), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(prepared, []byte("prepared copy"), 0600); err != nil {
		t.Fatal(err)
	}
	TouchTorrent("movie", tor)
	entries, err := ListCacheEntries()
	if err != nil || len(entries) != 1 {
		t.Fatalf("source reclamation record missing: %v %v", entries, err)
	}
	ih := tor.InfoHash()
	IncActive("movie", ih)
	_, err = EvictCachedInfoHash("movie", ih)
	DecActive("movie", ih)
	if err == nil {
		t.Fatal("active preparation's source was evicted")
	}
	freed, err := EvictCachedInfoHash("movie", ih)
	if err != nil {
		t.Fatal(err)
	}
	if freed != 16384 {
		t.Fatalf("reclaimed %d bytes", freed)
	}
	if _, err := os.Stat(source); !os.IsNotExist(err) {
		t.Fatalf("source payload retained: %v", err)
	}
	if _, err := os.Stat(source + ".part"); !os.IsNotExist(err) {
		t.Fatalf("partial payload retained: %v", err)
	}
	if _, err := os.Stat(prepared); err != nil {
		t.Fatalf("prepared package was evicted: %v", err)
	}
	// Reclamation must also work after restart with a legacy manifest that
	// records only the logical filename and has no client loaded.
	CloseAllClients()
	if err := os.WriteFile(source+".part", make([]byte, 16384), 0600); err != nil {
		t.Fatal(err)
	}
	if err := writeCacheEntry(entries[0]); err != nil {
		t.Fatal(err)
	}
	freed, err = EvictCachedInfoHash("movie", ih)
	if err != nil || freed != 16384 {
		t.Fatalf("legacy partial reclamation: bytes=%d err=%v", freed, err)
	}
	if _, err := os.Stat(prepared); err != nil {
		t.Fatalf("prepared copy removed during legacy cleanup: %v", err)
	}
}
