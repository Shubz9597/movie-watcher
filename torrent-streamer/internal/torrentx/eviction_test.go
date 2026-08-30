package torrentx

import (
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

func TestSafeCachePathRejectsTraversal(t *testing.T) {
	root := t.TempDir()
	if _, err := safeCachePath(root, "../outside.mkv"); err == nil {
		t.Fatal("expected traversal to be rejected")
	}
	if _, err := safeCachePath(root, "show/episode.mkv"); err != nil {
		t.Fatalf("safe nested path rejected: %v", err)
	}
}

func TestInvalidCategoryCannotSelectArbitraryDirectory(t *testing.T) {
	if got := validCat("../../outside"); got != "misc" {
		t.Fatalf("validCat traversal = %q, want misc", got)
	}
}

func TestParseSrcRejectsHTTPDownloadMasqueradingAsMagnet(t *testing.T) {
	query := url.Values{"magnet": {"http://prowlarr.test/download/123"}}
	if _, err := ParseSrc(query); err == nil {
		t.Fatal("HTTP download URL was accepted as a magnet")
	}
	query = url.Values{"src": {"https://prowlarr.test/download/123"}}
	if _, err := ParseSrc(query); err == nil {
		t.Fatal("HTTP download URL was accepted through src")
	}
}

func TestRemoveTorrentFilesRemovesOnlyListedFilesAndEmptyParents(t *testing.T) {
	root := t.TempDir()
	showDir := filepath.Join(root, "show")
	if err := os.MkdirAll(showDir, 0o755); err != nil {
		t.Fatal(err)
	}
	video := filepath.Join(showDir, "episode.mkv")
	keep := filepath.Join(showDir, "keep.txt")
	if err := os.WriteFile(video, []byte("video"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keep, []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}

	freed, err := removeTorrentFiles(root, []string{video})
	if err != nil {
		t.Fatal(err)
	}
	if freed != int64(len("video")) {
		t.Fatalf("freed = %d, want %d", freed, len("video"))
	}
	if _, err := os.Stat(video); !os.IsNotExist(err) {
		t.Fatalf("video still exists: %v", err)
	}
	if _, err := os.Stat(keep); err != nil {
		t.Fatalf("unlisted file was removed: %v", err)
	}
}
