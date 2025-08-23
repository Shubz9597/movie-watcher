package logx

import (
	"io"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Combined filter + de-dup writer.
// - allowPattern (optional): if set, only lines matching it pass
// - denyPattern  (optional): lines matching it are dropped
// - window: drop identical lines seen within this window (de-dup)
type Writer struct {
	dst         io.Writer
	allow, deny *regexp.Regexp
	window      time.Duration
	mu          sync.Mutex
	lastSeen    map[string]time.Time
	normalizeWS bool
}

func New(dst io.Writer, window time.Duration, allowPattern, denyPattern string) *Writer {
	var allowRE, denyRE *regexp.Regexp
	if strings.TrimSpace(allowPattern) != "" {
		if re, err := regexp.Compile(allowPattern); err == nil {
			allowRE = re
		} // else: fail-soft (log if you like)
	}
	if strings.TrimSpace(denyPattern) != "" {
		if re, err := regexp.Compile(denyPattern); err == nil {
			denyRE = re
		}
	}
	return &Writer{dst: dst, allow: allowRE, deny: denyRE, window: window, lastSeen: make(map[string]time.Time)}
}

func (w *Writer) Write(p []byte) (int, error) {
	line := string(p)

	// Filtering
	if w.deny != nil && w.deny.MatchString(line) {
		return len(p), nil
	}
	if w.allow != nil && !w.allow.MatchString(line) {
		return len(p), nil
	}

	// Normalize key for de-dup (trim newline)
	key := strings.TrimRight(line, "\r\n")

	now := time.Now()
	w.mu.Lock()
	last, ok := w.lastSeen[key]
	if ok && now.Sub(last) < w.window {
		w.mu.Unlock()
		return len(p), nil // drop duplicate within window
	}
	w.lastSeen[key] = now
	w.mu.Unlock()

	return w.dst.Write(p)
}
