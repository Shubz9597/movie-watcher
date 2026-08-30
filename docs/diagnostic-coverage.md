# Diagnostic coverage audit

This is an operational diagnostic system, not a compliance or business-event audit trail. It records application failures and the context needed to debug them; it does not record every user action.

## Files and correlation

All installed-app logs live in `%APPDATA%\TorWatch\logs`.

| File | Purpose |
| --- | --- |
| `errors.log` | Error-only JSONL index from Electron, every renderer, and the Go backend. Start here. |
| `frontend.log` | Full Electron/renderer context, including info and warnings. |
| `backend.log` | Full Go backend context, including streaming and worker activity. |

Every `errors.log` record contains `correlation_id`, `session_id`, and `source_log`. The same `correlation_id` is written into the referenced source log. Backend process crashes also include the tail of `backend.log`, so an unrecovered Go panic retains its runtime stack even though the backend logger could not handle it.

## Coverage matrix

| Failure boundary | Full log | `errors.log` | Diagnostic context |
| --- | --- | --- | --- |
| Electron main `console.error` | `frontend.log` | Yes | Arguments, error/cause stack, logging callsite |
| Electron uncaught exception | `frontend.log` | Yes | Exception stack and main-process callsite |
| Electron unhandled rejection | `frontend.log` | Yes | Rejection value/stack and main-process callsite |
| Main React renderer exception/rejection | `frontend.log` | Yes | Renderer filename, line, column, and stack |
| Setup renderer exception/rejection | `frontend.log` | Yes | Renderer filename, line, column, and stack |
| Startup renderer exception/rejection | `frontend.log` | Yes | Renderer filename, line, column, and stack |
| Player-controls exception/rejection | `frontend.log` | Yes | Renderer filename, line, column, and stack |
| Any renderer `console.error` | `frontend.log` | Yes | WebContents type/ID, source URL, and line |
| Renderer process crash | `frontend.log` | Yes | Electron crash reason and exit code |
| Electron GPU/utility child crash | `frontend.log` | Yes | Child type, reason, name, and exit code |
| Window/page load failure | `frontend.log` | Yes when terminal | URL loader error and callsite |
| MPV/native operation failure caught by Electron | `frontend.log` | Yes | Native error stack and operation callsite |
| Structured Go `slog.Error` | `backend.log` | Yes | Go source, error chain, current goroutine stack |
| Legacy Go failure log | `backend.log` | Yes | Go file/line, category, current goroutine stack |
| Recovered HTTP panic | `backend.log` | Yes | Request method/path, panic value, panic stack |
| Recovered worker/stream panic | `backend.log` | Yes | Worker category, source file/line, goroutine stack |
| Unrecovered Go panic/fatal exit | `backend.log` | Yes via Electron exit record | Backend exit data plus the last 12 KB of backend output |
| Backend spawn failure | `frontend.log` and attempted `backend.log` | Yes | Spawn error stack, path, and captured backend tail |
| Backend diagnostic-file failure | stdout fallback/`backend.log` | Yes when error index is available | Failed path and filesystem error |

Expected retry/fallback warnings remain in the full source log but do not enter `errors.log`. Known harmless `FlushFileBuffers`/invalid-handle noise is denied before either backend file is written. Genuine standalone permission errors are retained.

## Known hard limits

- Power loss, forced process termination, and some native access violations can stop a process before it can write a final record. Existing synchronous records remain on disk.
- An OS failure that prevents writes to the entire log directory cannot be captured in that directory; the Go backend falls back to stdout where possible.
- Automatic redaction covers known credential keys, bearer tokens, database passwords, and magnet links. Logs should still be reviewed before public sharing.

## Bug-report workflow

1. Reproduce the failure once and close TorWatch normally if possible.
2. Share `errors.log` first.
3. Share the `source_log` named by the relevant error record. Include rotated `.1` history when the current file does not contain its correlation ID.
4. A debugger can search the source log for `correlation_id=<value>` to see the events immediately before and after the failure.
