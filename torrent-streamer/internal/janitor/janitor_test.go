package janitor

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSourceBudgetExcludesPreparedPackages(t *testing.T) {
	root := t.TempDir()
	for _, category := range []string{"movie", "tv", "anime", "misc", "downloads", "playback"} {
		dir := filepath.Join(root, category)
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "video"), []byte("12345"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if got := sourceCacheBytes(root); got != 20 {
		t.Fatalf("source bytes=%d, want 20", got)
	}
}
