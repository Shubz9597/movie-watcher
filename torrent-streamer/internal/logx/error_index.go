package logx

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"runtime/debug"
	"strings"
	"sync"
	"time"
)

var (
	errorLinePattern        = regexp.MustCompile(`(?i)(?:level=ERROR|\b(?:error|failed|failure|fatal|panic|cannot|unable|unavailable|timeout|timed out|missing|required|refused|refusing|denied)\b|\binit:)`)
	scopePattern            = regexp.MustCompile(`\[([a-zA-Z0-9_/-]+)\]`)
	structuredSourcePattern = regexp.MustCompile(`\bsource=([^\s]+)`)
	legacySourcePattern     = regexp.MustCompile(`\b([^\s/:]+\.go:\d+):`)
)

// ErrorIndexWriter copies failure records to a JSONL error index and adds the
// same correlation ID to the full backend diagnostic line.
type ErrorIndexWriter struct {
	dst       io.Writer
	errorDst  io.Writer
	sessionID string
	mu        sync.Mutex
}

type errorIndexRecord struct {
	Timestamp     string `json:"timestamp"`
	Level         string `json:"level"`
	Process       string `json:"process"`
	Scope         string `json:"scope,omitempty"`
	SessionID     string `json:"session_id,omitempty"`
	CorrelationID string `json:"correlation_id"`
	SourceLog     string `json:"source_log"`
	Source        string `json:"source,omitempty"`
	Message       string `json:"message"`
	Stack         string `json:"stack"`
}

func NewErrorIndex(dst, errorDst io.Writer, sessionID string) *ErrorIndexWriter {
	return &ErrorIndexWriter{dst: dst, errorDst: errorDst, sessionID: sessionID}
}

func (w *ErrorIndexWriter) Write(p []byte) (int, error) {
	line := string(p)
	if !errorLinePattern.MatchString(line) {
		return w.dst.Write(p)
	}

	correlationID := newCorrelationID()
	linkedLine := strings.TrimRight(line, "\r\n") + " correlation_id=" + correlationID + "\n"
	record := errorIndexRecord{
		Timestamp:     time.Now().UTC().Format(time.RFC3339Nano),
		Level:         "error",
		Process:       "backend",
		Scope:         extractMatch(scopePattern, line),
		SessionID:     w.sessionID,
		CorrelationID: correlationID,
		SourceLog:     "backend.log",
		Source:        extractSource(line),
		Message:       strings.TrimSpace(line),
		Stack:         string(debug.Stack()),
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		return 0, fmt.Errorf("marshal error index record: %w", err)
	}
	encoded = append(encoded, '\n')

	w.mu.Lock()
	defer w.mu.Unlock()
	if _, err := io.WriteString(w.dst, linkedLine); err != nil {
		return 0, err
	}
	if _, err := w.errorDst.Write(encoded); err != nil {
		return 0, err
	}
	return len(p), nil
}

func extractSource(line string) string {
	if source := extractMatch(structuredSourcePattern, line); source != "" {
		return strings.Trim(source, `"`)
	}
	return extractMatch(legacySourcePattern, line)
}

func extractMatch(pattern *regexp.Regexp, value string) string {
	match := pattern.FindStringSubmatch(value)
	if len(match) < 2 {
		return ""
	}
	return match[1]
}

func newCorrelationID() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err == nil {
		return hex.EncodeToString(value[:])
	}
	return fmt.Sprintf("fallback-%d", time.Now().UTC().UnixNano())
}
