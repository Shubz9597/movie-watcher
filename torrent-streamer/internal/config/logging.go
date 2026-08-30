package config

import (
	"io"
	"log"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"

	"torrent-streamer/internal/logx"
)

func SetupLogging() func() {
	console := logx.New(os.Stdout, LogDedupWindow(), LogAllowRegex(), LogDenyRegex())
	var out io.Writer = io.Discard
	if LogConsole() {
		out = console
	}
	var diagnosticOpenErr error
	var errorIndexOpenErr error
	var diagnostic *logx.Writer
	closeLog := func() {}
	if p := LogFilePath(); p != "" {
		var diagnosticFile *os.File
		diagnosticFile, diagnosticOpenErr = openAppendFile(p)
		if diagnosticOpenErr == nil {
			var errorFile *os.File
			errorFile, errorIndexOpenErr = openAppendFile(ErrorLogPath())
			var diagnosticDst io.Writer = diagnosticFile
			if errorIndexOpenErr == nil {
				diagnosticDst = logx.NewErrorIndex(diagnosticFile, errorFile, os.Getenv("TORWATCH_DIAGNOSTIC_SESSION_ID"))
			}
			// The console remains concise, but the diagnostic file only applies the
			// deny-list. Important categories can never disappear behind LOG_ALLOW.
			diagnostic = logx.New(diagnosticDst, 0, "", LogDenyRegex())
			if LogConsole() {
				out = io.MultiWriter(console, diagnostic)
			} else {
				out = diagnostic
			}
			closeLog = func() {
				_ = console.Flush()
				_ = diagnostic.Flush()
				_ = diagnosticFile.Close()
				if errorFile != nil {
					_ = errorFile.Close()
				}
			}
		}
	}

	if diagnosticOpenErr != nil {
		// Fall back to an unfiltered console so losing the file cannot also hide
		// the error that explains why diagnostics are unavailable.
		out = logx.New(os.Stdout, LogDedupWindow(), "", LogDenyRegex())
	}
	var consoleFallback bool
	if LogFilePath() == "" && !LogConsole() {
		out = logx.New(os.Stdout, LogDedupWindow(), "", LogDenyRegex())
		consoleFallback = true
	}
	handler := slog.NewTextHandler(out, &slog.HandlerOptions{
		AddSource: true,
		Level:     slog.LevelDebug,
		ReplaceAttr: func(_ []string, attr slog.Attr) slog.Attr {
			if attr.Key == slog.TimeKey {
				attr.Value = slog.TimeValue(attr.Value.Time().UTC())
			}
			return attr
		},
	})
	slog.SetDefault(slog.New(handler))
	// Keep legacy log.Printf callers on the same output while preserving their
	// exact file:line callsite. New logging code uses slog directly.
	log.SetFlags(log.Ldate | log.Ltime | log.Lmicroseconds | log.LUTC | log.Lshortfile)
	log.SetPrefix("")
	log.SetOutput(out)
	if diagnosticOpenErr != nil {
		slog.Error("diagnostic log unavailable", "err", diagnosticOpenErr, "file", LogFilePath())
	}
	if errorIndexOpenErr != nil {
		slog.Error("error index unavailable", "err", errorIndexOpenErr, "file", ErrorLogPath())
	}
	if consoleFallback {
		slog.Warn("diagnostic output fell back to stdout", "reason", "LOG_FILE is empty and LOG_CONSOLE is false")
	}
	slog.Info("logging configured",
		"app_version", os.Getenv("TORWATCH_APP_VERSION"),
		"diagnostic_session_id", os.Getenv("TORWATCH_DIAGNOSTIC_SESSION_ID"),
		"go_version", runtime.Version(),
		"platform", runtime.GOOS,
		"arch", runtime.GOARCH,
		"pid", os.Getpid(),
		"file", LogFilePath(),
		"error_file", ErrorLogPath(),
		"console", LogConsole(),
		"dedup_window", LogDedupWindow(),
		"allow_pattern", LogAllowRegex(),
		"deny_filter_configured", LogDenyRegex() != "",
	)
	return closeLog
}

func openAppendFile(filePath string) (*os.File, error) {
	if dir := filepath.Dir(filePath); dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, err
		}
	}
	return os.OpenFile(filePath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
}
