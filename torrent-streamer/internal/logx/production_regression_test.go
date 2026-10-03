package logx

import (
	"fmt"
	"io"
	"testing"
	"time"
)

func TestRegressionZeroWindowLogRetention(t *testing.T) {
	w := New(io.Discard, 0, "", "")
	for i := 0; i < 10000; i++ {
		fmt.Fprintf(w, "request %d at %s", i, time.Now())
	}
	if len(w.lastSeen) != 0 {
		t.Errorf("zero-window diagnostic writer retained %d unique records, want no dedup history", len(w.lastSeen))
	}
}

func TestDedupHistoryIsBoundedAndExpires(t *testing.T) {
	w := New(io.Discard, time.Hour, "", "")
	w.lastSeen["expired"] = time.Now().Add(-2 * time.Hour)
	for i := 0; i < 4200; i++ {
		fmt.Fprintf(w, "unique %d", i)
	}
	if len(w.lastSeen) > 4096 {
		t.Fatalf("retained %d records", len(w.lastSeen))
	}
	if _, ok := w.lastSeen["expired"]; ok {
		t.Fatal("expired record retained")
	}
	w.Write([]byte("same"))
	before := w.lastSeen["same"]
	w.Write([]byte("same"))
	if w.lastSeen["same"] != before {
		t.Fatal("suppressed record extended its history")
	}
}
