package bootstrap

import (
	"log/slog"
	"strings"
)

// newTestLogger returns a slog.Logger writing to buf for redaction asserts.
func newTestLogger(buf *strings.Builder) *slog.Logger {
	return slog.New(slog.NewTextHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
}
