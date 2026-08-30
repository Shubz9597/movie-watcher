package logx

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestErrorIndexLinksFailureToBackendLog(t *testing.T) {
	var backend bytes.Buffer
	var errors bytes.Buffer
	writer := NewErrorIndex(&backend, &errors, "session-123")

	if _, err := writer.Write([]byte("2026/08/24 handlers.go:42: [stream] request failed: boom\n")); err != nil {
		t.Fatalf("write failure: %v", err)
	}
	if _, err := writer.Write([]byte("2026/08/24 handlers.go:43: [stream] request complete\n")); err != nil {
		t.Fatalf("write informational record: %v", err)
	}

	var record errorIndexRecord
	if err := json.Unmarshal(errors.Bytes(), &record); err != nil {
		t.Fatalf("decode error index: %v", err)
	}
	if record.CorrelationID == "" || record.SessionID != "session-123" {
		t.Fatalf("missing correlation fields: %#v", record)
	}
	if record.Source != "handlers.go:42" || record.Scope != "stream" {
		t.Fatalf("missing source context: %#v", record)
	}
	if !strings.Contains(backend.String(), "correlation_id="+record.CorrelationID) {
		t.Fatalf("backend record is not linked: %q", backend.String())
	}
	if strings.Count(errors.String(), "\n") != 1 {
		t.Fatalf("informational record reached error index: %q", errors.String())
	}
}
