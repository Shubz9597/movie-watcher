package logx

import (
	"bytes"
	"strings"
	"testing"
)

func TestRedactCoversServerConfigSecretShapes(t *testing.T) {
	cases := []struct {
		name   string
		input  string
		leak   string
		wantSt string
	}{
		{
			name:   "postgres DSN password",
			input:  "dial postgres://torwatch:sup3r$ecret@db:5432/torwatch?sslmode=disable",
			leak:   "sup3r$ecret",
			wantSt: "postgres://torwatch:[redacted]@db:5432/torwatch?sslmode=disable",
		},
		{
			name:   "postgresql DSN password",
			input:  "postgresql://svc:hunter2@db.internal:5432/torwatch",
			leak:   "hunter2",
			wantSt: "postgresql://svc:[redacted]@db.internal:5432/torwatch",
		},
		{
			name:   "prowlarr api key in query string",
			input:  "GET http://prowlarr:9696/api/v1/search?apikey=PROWLARR-SECRET&query=frieren",
			leak:   "PROWLARR-SECRET",
			wantSt: "?apikey=[redacted]",
		},
		{
			name:   "X-Api-Key header form",
			input:  "request rejected: X-Api-Key: sk-live-123456",
			leak:   "sk-live-123456",
			wantSt: "X-Api-Key: [redacted]",
		},
		{
			name:   "JSON-shaped api key",
			input:  `{"api_key":"abc123","component":"prowlarr"}`,
			leak:   "abc123",
			wantSt: `"api_key":[redacted]`,
		},
		{
			name:   "magnet in an error message",
			input:  `stream failed for magnet:?xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567`,
			leak:   "0123456789ABCDEF0123456789ABCDEF01234567",
			wantSt: "magnet:[redacted]",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			output := redact(c.input)
			if strings.Contains(output, c.leak) {
				t.Fatalf("secret leaked: %q", output)
			}
			if !strings.Contains(output, c.wantSt) {
				t.Fatalf("redaction marker missing: %q (want %q)", output, c.wantSt)
			}
		})
	}
}

func TestWriterRedactsSystemPathDiagnostics(t *testing.T) {
	var destination bytes.Buffer
	writer := New(&destination, 0, "", `(?i)msg="error flushing piece storage".*FlushFileBuffers:\s*The handle is invalid`)

	input := "[readyz] postgres probe failed for postgres://torwatch:sup3r$ecret@db:5432/torwatch apikey=PROWLARR-SECRET\n"
	if _, err := writer.Write([]byte(input)); err != nil {
		t.Fatalf("write readiness diagnostic: %v", err)
	}
	output := destination.String()
	if strings.Contains(output, "sup3r$ecret") || strings.Contains(output, "PROWLARR-SECRET") {
		t.Fatalf("system-path diagnostic leaked a secret: %q", output)
	}
	if !strings.Contains(output, "[readyz]") || !strings.Contains(output, "probe failed") {
		t.Fatalf("actionable context was lost: %q", output)
	}
}
