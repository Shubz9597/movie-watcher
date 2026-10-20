package httpapi

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"torrent-streamer/internal/config"
	"torrent-streamer/internal/middleware"
)

// POST /v1/diagnostics/events {device, events: [{at, kind, detail}]} keeps
// the phone player's events (audio interruptions, Play presses, player
// states) in <data>/diagnostics/phone.log, so a problem seen on the device
// can be read on the server. The file is capped; the previous one is kept
// as phone.log.1.

const (
	diagnosticsMaxBody = 64 << 10
	diagnosticsMaxFile = 2 << 20
)

var diagnosticsMu sync.Mutex

type diagnosticEvent struct {
	At     int64           `json:"at"`
	Kind   string          `json:"kind"`
	Detail json.RawMessage `json:"detail"`
}

func HandleDiagnosticEvents(w http.ResponseWriter, r *http.Request) {
	middleware.EnableCORS(w)
	if r.Method == http.MethodOptions {
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Device string            `json:"device"`
		Events []diagnosticEvent `json:"events"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, diagnosticsMaxBody)).Decode(&body); err != nil {
		http.Error(w, "invalid events", http.StatusBadRequest)
		return
	}
	device := strings.Map(func(r rune) rune {
		if r < 32 || r == 127 {
			return -1
		}
		return r
	}, body.Device)
	if len(device) > 40 {
		device = device[:40]
	}
	var lines strings.Builder
	for _, event := range body.Events {
		kind := strings.TrimSpace(event.Kind)
		if kind == "" || len(kind) > 60 || strings.ContainsAny(kind, "\r\n") {
			continue
		}
		detail := string(event.Detail)
		if len(detail) > 2000 {
			detail = detail[:2000]
		}
		at := time.UnixMilli(event.At).UTC().Format("2006-01-02T15:04:05.000Z")
		fmt.Fprintf(&lines, "%s %s %s %s\n", at, device, kind, strings.ReplaceAll(detail, "\n", " "))
	}
	if lines.Len() > 0 {
		if err := appendDiagnostics(lines.String()); err != nil {
			http.Error(w, "could not keep events", http.StatusInternalServerError)
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func appendDiagnostics(text string) error {
	diagnosticsMu.Lock()
	defer diagnosticsMu.Unlock()
	dir := filepath.Join(config.DataRoot(), "diagnostics")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	path := filepath.Join(dir, "phone.log")
	if info, err := os.Stat(path); err == nil && info.Size() > diagnosticsMaxFile {
		_ = os.Rename(path, path+".1")
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = file.WriteString(text)
	return err
}
