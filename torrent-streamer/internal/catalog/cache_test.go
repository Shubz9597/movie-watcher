package catalog

import (
	"testing"
	"time"
)

func TestCacheFreshStaleAndMissing(t *testing.T) {
	cache := NewCache(8)
	cache.Set("tmdb", "q1", []string{"a"}, 10*time.Minute)

	if value, state, ok := cache.Get("tmdb", "q1"); !ok || state != cacheStateFresh {
		t.Fatalf("fresh get = %v %v %v", value, state, ok)
	}

	if _, _, ok := cache.Get("anilist", "q1"); ok {
		t.Fatal("cross-provider key isolation broken")
	}
	if _, _, ok := cache.Get("tmdb", "q2"); ok {
		t.Fatal("missing key reported as present")
	}

	// Simulate expiry: re-set with a negative TTL via direct entry manipulation
	// is not possible; use Set with zero TTL and rely on Now-based staleness by
	// waiting deterministically through the public API instead.
	cache.Set("tmdb", "q3", []string{"b"}, -1*time.Second)
	if value, state, ok := cache.Get("tmdb", "q3"); !ok || state != cacheStateStale {
		t.Fatalf("stale get = %v %v %v", value, state, ok)
	}
}

func TestCacheBoundedEviction(t *testing.T) {
	cache := NewCache(2)
	cache.Set("p", "a", "a-value", 10*time.Minute)
	cache.Set("p", "b", "b-value", 20*time.Minute)
	cache.Set("p", "c", "c-value", 30*time.Minute) // triggers eviction of oldest-expiry "a"

	if _, _, ok := cache.Get("p", "a"); ok {
		t.Fatal("bound exceeded: oldest-expiry entry must be evicted")
	}
	if _, _, ok := cache.Get("p", "b"); !ok {
		t.Fatal("fresh entry b should remain")
	}
}

func TestCacheStaleEntriesServedWhileWithinBound(t *testing.T) {
	cache := NewCache(4)
	cache.Set("p", "a", "a-value", -1*time.Second) // stale-but-valid
	cache.Set("p", "b", "b-value", 10*time.Minute)
	if value, state, ok := cache.Get("p", "a"); !ok || state != cacheStateStale || value != "a-value" {
		t.Fatalf("stale entry must be served while within bound: %v %v %v", value, state, ok)
	}
}
