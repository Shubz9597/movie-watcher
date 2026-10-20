package httpapi

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"torrent-streamer/internal/config"
)

func TestDiagnosticEventsAreKept(t *testing.T) {
	t.Setenv("TORRENT_DATA_ROOT", t.TempDir())
	config.Load()
	body := `{"device":"iPhone","events":[{"at":1792500000000,"kind":"interruption","detail":{"type":"began"}},{"at":1792500001000,"kind":"bad\nkind","detail":{}}]}`
	rec := httptest.NewRecorder()
	HandleDiagnosticEvents(rec, httptest.NewRequest("POST", "/v1/diagnostics/events", strings.NewReader(body)))
	if rec.Code != 204 {
		t.Fatalf("status %d", rec.Code)
	}
	data, err := os.ReadFile(filepath.Join(config.DataRoot(), "diagnostics", "phone.log"))
	if err != nil {
		t.Fatal(err)
	}
	if text := string(data); !strings.Contains(text, `iPhone interruption {"type":"began"}`) || strings.Contains(text, "bad") {
		t.Fatalf("log = %q", text)
	}
}
