package subtitles

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSubtitleCachesExpireAndBoundMemory(t *testing.T) {
	subCacheMu.Lock()
	defer subCacheMu.Unlock()
	searchCacheMu.Lock()
	defer searchCacheMu.Unlock()
	oldSubs, oldSearch := subCache, searchCache
	defer func() { subCache, searchCache = oldSubs, oldSearch }()
	subCache, searchCache = map[string]cachedSub{}, map[string]cachedSearch{}
	now := time.Now()
	subCache["expired"] = cachedSub{vtt: "old", fetched: now.Add(-2 * cacheTTL)}
	searchCache["expired"] = cachedSearch{fetched: now.Add(-2 * searchCacheTTL)}
	for i := 0; i < 300; i++ {
		key := fmt.Sprint(i)
		putSubtitleLocked(key, strings.Repeat("x", 256<<10), now.Add(time.Duration(i)*time.Second))
		putSearchLocked(key, []SubResult{{ID: key}}, now.Add(time.Duration(i)*time.Second))
	}
	if _, ok := subCache["expired"]; ok {
		t.Error("expired subtitle retained")
	}
	if _, ok := searchCache["expired"]; ok {
		t.Error("expired search retained")
	}
	var total int
	for _, entry := range subCache {
		total += len(entry.vtt)
	}
	if total > subtitleCacheMaxBytes || len(subCache) > subtitleCacheMaxEntries || len(searchCache) > subtitleCacheMaxEntries {
		t.Fatalf("unbounded caches: bytes=%d subtitles=%d searches=%d", total, len(subCache), len(searchCache))
	}
}

func TestProviderDiskCachePrunesExpiredFilesOnly(t *testing.T) {
	root := t.TempDir()
	expired := filepath.Join(root, "opensub-1.vtt")
	keep := filepath.Join(root, "import-user.vtt")
	for _, path := range []string{expired, keep} {
		if err := os.WriteFile(path, []byte("WEBVTT\n"), 0600); err != nil {
			t.Fatal(err)
		}
		old := time.Now().Add(-2 * cacheTTL)
		if err := os.Chtimes(path, old, old); err != nil {
			t.Fatal(err)
		}
	}
	if err := pruneDiskSubtitles(root); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(expired); !os.IsNotExist(err) {
		t.Fatalf("expired cache remains: %v", err)
	}
	if _, err := os.Stat(keep); err != nil {
		t.Fatalf("user import removed: %v", err)
	}
}
