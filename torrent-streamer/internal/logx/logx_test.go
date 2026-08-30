package logx

import (
	"bytes"
	"strings"
	"testing"
)

func TestWriterFiltersAndRedacts(t *testing.T) {
	var destination bytes.Buffer
	writer := New(&destination, 0, "", `(?i)msg="error flushing piece storage".*FlushFileBuffers:\s*The handle is invalid`)

	input := "request magnet:?xt=urn:btih:abc&tr=https://secret.example token=private\n"
	if _, err := writer.Write([]byte(input)); err != nil {
		t.Fatalf("write diagnostic: %v", err)
	}
	output := destination.String()
	if strings.Contains(output, "secret.example") || strings.Contains(output, "private") {
		t.Fatalf("diagnostic contains a secret: %q", output)
	}
	if !strings.Contains(output, "magnet:[redacted]") || !strings.Contains(output, "token=[redacted]") {
		t.Fatalf("diagnostic was not redacted: %q", output)
	}
}

func TestWriterDropsHarmlessTorrentFlushRecord(t *testing.T) {
	var destination bytes.Buffer
	writer := New(&destination, 0, "", `(?i)msg="error flushing piece storage".*FlushFileBuffers:\s*The handle is invalid`)

	header := "[2026-08-24 03:09:02 +0530 WRN github.com/anacrolix/torrent torrent.go:2573]\n"
	detail := `  msg="error flushing piece storage" piece=74 err="flushing movie.mp4.part: FlushFileBuffers: The handle is invalid."` + "\n"
	if _, err := writer.Write([]byte(header)); err != nil {
		t.Fatalf("write torrent header: %v", err)
	}
	if _, err := writer.Write([]byte(detail)); err != nil {
		t.Fatalf("write harmless torrent detail: %v", err)
	}
	if output := destination.String(); output != "" {
		t.Fatalf("harmless flush record reached diagnostics: %q", output)
	}
}

func TestWriterKeepsActionableTorrentIOError(t *testing.T) {
	var destination bytes.Buffer
	writer := New(&destination, 0, "", `(?i)msg="error flushing piece storage".*FlushFileBuffers:\s*The handle is invalid`)

	header := "[2026-08-24 03:09:02 +0530 WRN github.com/anacrolix/torrent torrent.go:2573]\n"
	detail := `  msg="error flushing piece storage" piece=74 err="FlushFileBuffers: Access is denied."` + "\n"
	if _, err := writer.Write([]byte(header)); err != nil {
		t.Fatalf("write torrent header: %v", err)
	}
	if _, err := writer.Write([]byte(detail)); err != nil {
		t.Fatalf("write actionable torrent detail: %v", err)
	}

	output := destination.String()
	if !strings.Contains(output, "torrent.go:2573") || !strings.Contains(output, "Access is denied") {
		t.Fatalf("actionable I/O record was lost: %q", output)
	}
}

func TestWriterFlushesUnpairedTorrentHeader(t *testing.T) {
	var destination bytes.Buffer
	writer := New(&destination, 0, "", `(?i)msg="error flushing piece storage".*FlushFileBuffers:\s*The handle is invalid`)

	header := "[2026-08-24 03:09:02 +0530 ERR github.com/anacrolix/torrent torrent.go:999]\n"
	if _, err := writer.Write([]byte(header)); err != nil {
		t.Fatalf("write torrent header: %v", err)
	}
	if err := writer.Flush(); err != nil {
		t.Fatalf("flush torrent header: %v", err)
	}
	if output := destination.String(); output != header {
		t.Fatalf("unpaired error header was lost: %q", output)
	}
}
