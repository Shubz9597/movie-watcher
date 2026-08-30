package config

import (
	"encoding/json"
	"io"
	"log"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDiagnosticFileIgnoresConsoleAllowList(t *testing.T) {
	originalFile := logFilePath
	originalErrorFile := errorLogPath
	originalAllow := logAllowRegex
	originalDeny := logDenyRegex
	originalDedup := logDedupWin
	originalConsole := logConsole
	originalSlog := slog.Default()
	t.Cleanup(func() {
		logFilePath = originalFile
		errorLogPath = originalErrorFile
		logAllowRegex = originalAllow
		logDenyRegex = originalDeny
		logDedupWin = originalDedup
		logConsole = originalConsole
		log.SetOutput(io.Discard)
		slog.SetDefault(originalSlog)
	})

	logFilePath = filepath.Join(t.TempDir(), "backend.log")
	errorLogPath = filepath.Join(t.TempDir(), "errors.log")
	logAllowRegex = `^.*\[allowed\]`
	logDenyRegex = `(?i)msg="error flushing piece storage".*FlushFileBuffers:\s*The handle is invalid`
	logDedupWin = 0
	logConsole = false

	closeLog := SetupLogging()
	log.Print("[database] actionable failure")
	log.Print("[allowed] visible message")
	log.Print(`[stream] msg="error flushing piece storage" err="FlushFileBuffers: The handle is invalid"`)
	closeLog()

	data, err := os.ReadFile(logFilePath)
	if err != nil {
		t.Fatalf("read diagnostic log: %v", err)
	}
	output := string(data)
	if !strings.Contains(output, "[database] actionable failure") {
		t.Fatalf("allow-list hid an actionable file record: %q", output)
	}
	if !strings.Contains(output, "logging_test.go:") {
		t.Fatalf("source location is missing: %q", output)
	}
	if strings.Contains(output, "FlushFileBuffers") {
		t.Fatalf("harmless flush noise reached the file: %q", output)
	}
	errorData, err := os.ReadFile(errorLogPath)
	if err != nil {
		t.Fatalf("read error index: %v", err)
	}
	var indexed struct {
		CorrelationID string `json:"correlation_id"`
		SourceLog     string `json:"source_log"`
	}
	if err := json.Unmarshal(errorData, &indexed); err != nil {
		t.Fatalf("decode error index: %v", err)
	}
	if indexed.CorrelationID == "" || indexed.SourceLog != "backend.log" {
		t.Fatalf("error index is not correlated: %#v", indexed)
	}
	if !strings.Contains(output, "correlation_id="+indexed.CorrelationID) {
		t.Fatalf("backend log is missing correlation link: %q", output)
	}
}
