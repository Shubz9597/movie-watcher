package config

import (
	"os"
	"strconv"
	"strings"
	"time"
)

var (
	dataRoot         = "./vod-cache"
	cacheMaxBytes    int64
	evictTTL         time.Duration
	waitMetadata     = 25 * time.Second
	prebufferBytes   = int64(1 << 20) // 1 MiB
	prebufferTimeout = 15 * time.Second
	trackersMode     = "udp" // all|http|udp|none

	targetPlaySec   int64 = 90
	targetPauseSec  int64 = 360
	warmReadAheadMB int64 = 100

	targetPlay4KSec   int64 = 180
	targetPause4KSec  int64 = 600
	warmReadAhead4KMB int64 = 128

	endgameDuplicate = true
	watchDropGuard   = 10 * time.Minute

	listenAddr = ":4001"

	// logging
	logFilePath   = "debug.log"
	logAllowRegex = `^\[(init|boot|http|add|files|prefetch|stream|watch|janitor|stats|trackers)\]`
	logDenyRegex  = `FlushFileBuffers|fsync|WriteFile|The handle is invalid|Access is denied|Permission denied`
	logDedupWin   = 3 * time.Second
)

func Load() {
	if v := getenv("TORRENT_DATA_ROOT", ""); v != "" {
		dataRoot = v
	}
	_ = os.MkdirAll(dataRoot, 0o755)

	cacheMaxBytes = getenvInt64("CACHE_MAX_BYTES", 0)
	evictTTL = getenvDuration("CACHE_EVICT_TTL", 0)

	waitMetadata = getenvDuration("WAIT_METADATA", waitMetadata)
	if ms := getenvInt64("WAIT_METADATA_MS", 0); ms > 0 {
		waitMetadata = time.Duration(ms) * time.Millisecond
	}

	prebufferBytes = getenvInt64("PREBUFFER_BYTES", prebufferBytes)
	prebufferTimeout = getenvDuration("PREBUFFER_TIMEOUT", prebufferTimeout)
	if ms := getenvInt64("PREBUFFER_TIMEOUT_MS", 0); ms > 0 {
		prebufferTimeout = time.Duration(ms) * time.Millisecond
	}

	trackersMode = strings.ToLower(getenv("TRACKERS_MODE", trackersMode))

	targetPlaySec = getenvInt64("TARGET_BUFFER_PLAY_SEC", targetPlaySec)
	targetPauseSec = getenvInt64("TARGET_BUFFER_PAUSE_SEC", targetPauseSec)
	warmReadAheadMB = getenvInt64("WARM_READ_AHEAD_MB", warmReadAheadMB)

	// 4K overrides
	targetPlay4KSec = getenvInt64("TARGET_BUFFER_PLAY_SEC_4K", targetPlay4KSec)
	targetPause4KSec = getenvInt64("TARGET_BUFFER_PAUSE_SEC_4K", targetPause4KSec)
	warmReadAhead4KMB = getenvInt64("WARM_READ_AHEAD_MB_4K", warmReadAhead4KMB)

	watchDropGuard = getenvDuration("WATCH_DROP_GUARD", watchDropGuard)

	endgameDuplicate = strings.ToLower(getenv("ENDGAME_DUPLICATE", "true")) != "false"

	listenAddr = getenv("LISTEN", listenAddr)

	logFilePath = getenv("LOG_FILE", logFilePath)
	logAllowRegex = getenv("LOG_ALLOW", logAllowRegex)
	logDenyRegex = getenv("LOG_DENY", logDenyRegex)
	logDedupWin = getenvDuration("LOG_DEDUP_WINDOW", logDedupWin)
}

// getters
func DataRoot() string                   { return dataRoot }
func CacheMaxBytes() int64               { return cacheMaxBytes }
func EvictTTL() time.Duration            { return evictTTL }
func WaitMetadata() time.Duration        { return waitMetadata }
func PrebufferBytes() int64              { return prebufferBytes }
func PrebufferTimeout() time.Duration    { return prebufferTimeout }
func TrackersMode() string               { return trackersMode }
func TargetPlaySec() int64               { return targetPlaySec }
func TargetPauseSec() int64              { return targetPauseSec }
func WarmReadAheadMB() int64             { return warmReadAheadMB }
func TargetPlay4KSec() int64             { return targetPlay4KSec }
func TargetPause4KSec() int64            { return targetPause4KSec }
func WarmReadAhead4KMB() int64           { return warmReadAhead4KMB }
func EndgameDuplicate() bool             { return endgameDuplicate }
func WatchDropGuard() time.Duration      { return watchDropGuard }
func ListenAddr() string                 { return listenAddr }
func LogFilePath() string                { return logFilePath }
func LogAllowRegex() string              { return logAllowRegex }
func LogDenyRegex() string               { return logDenyRegex }
func LogDedupWindow() time.Duration      { return logDedupWin }

// helpers
func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
func getenvInt64(k string, def int64) int64 {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			return n
		}
	}
	return def
}
func getenvDuration(k string, def time.Duration) time.Duration {
	if v := os.Getenv(k); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return def
}
