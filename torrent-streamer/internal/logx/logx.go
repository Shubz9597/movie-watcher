package logx

import (
	"io"
	"regexp"
	"strings"
	"sync"
	"time"
)

var (
	magnetPattern        = regexp.MustCompile(`(?i)magnet:\?[^\s"']+`)
	postgresPattern      = regexp.MustCompile(`(?i)\b(postgres(?:ql)?://[^:\s/@]+:)[^@\s/]+@`)
	querySecretPattern   = regexp.MustCompile(`(?i)([?&](?:api[_-]?key|access[_-]?token|token|password|private[_-]?key|secret)=)[^&\s]+`)
	keySecretPattern     = regexp.MustCompile(`(?i)\b((?:api[_-]?key|access[_-]?token|authorization|password|private[_-]?key|secret|token)\s*[:=]\s*)([^,;\s]+)`)
	torrentHeaderPattern = regexp.MustCompile(`^\[[^\r\n\]]+\s+(?:WRN|ERR)\s+github\.com/anacrolix/torrent\S*\s+[^\r\n\]]+\]\r?\n?$`)
	torrentDetailPattern = regexp.MustCompile(`^[\t ]+`)
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
	pending     string
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
	line := redact(string(p))
	w.mu.Lock()
	defer w.mu.Unlock()

	// anacrolix emits a structured record as two writes: a message-free header,
	// followed by an indented detail line. Hold the header until the detail is
	// available so a denied detail does not leave a misleading orphan warning.
	if torrentHeaderPattern.MatchString(line) {
		if err := w.flushPendingLocked(); err != nil {
			return 0, err
		}
		w.pending = line
		return len(p), nil
	}

	if w.pending != "" {
		if torrentDetailPattern.MatchString(line) && w.denied(line) {
			w.pending = ""
			return len(p), nil
		}
		if err := w.flushPendingLocked(); err != nil {
			return 0, err
		}
	}

	if err := w.writeFilteredLocked(line); err != nil {
		return 0, err
	}
	return len(p), nil
}

// Flush writes a held third-party log header when no detail line followed it.
func (w *Writer) Flush() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.flushPendingLocked()
}

func (w *Writer) flushPendingLocked() error {
	if w.pending == "" {
		return nil
	}
	pending := w.pending
	w.pending = ""
	return w.writeFilteredLocked(pending)
}

func (w *Writer) writeFilteredLocked(line string) error {
	if w.denied(line) {
		return nil
	}
	if w.allow != nil && !w.allow.MatchString(line) {
		return nil
	}

	key := strings.TrimRight(line, "\r\n")
	now := time.Now()
	if last, ok := w.lastSeen[key]; ok && now.Sub(last) < w.window {
		return nil
	}
	w.lastSeen[key] = now

	_, err := io.WriteString(w.dst, line)
	return err
}

func (w *Writer) denied(line string) bool {
	if w.deny != nil && w.deny.MatchString(line) {
		return true
	}
	return false
}

func redact(value string) string {
	value = magnetPattern.ReplaceAllString(value, "magnet:[redacted]")
	value = postgresPattern.ReplaceAllString(value, "${1}[redacted]@")
	value = querySecretPattern.ReplaceAllString(value, "${1}[redacted]")
	return keySecretPattern.ReplaceAllString(value, "${1}[redacted]")
}
