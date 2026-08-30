import fs from "fs";
import path from "path";
import crypto from "crypto";
import util from "util";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_BACKUPS = 3;
const MAX_STRING_LENGTH = 16_000;
const SENSITIVE_KEY = /(?:api[_-]?key|access[_-]?token|auth(?:orization)?|cookie|password|private[_-]?key|secret|session[_-]?id|user[_-]?token)/i;

function truncate(value, limit = MAX_STRING_LENGTH) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}…[truncated ${value.length - limit} chars]`;
}

export function redactText(input) {
  let value = String(input);
  value = value.replace(/magnet:\?[^\s"']+/gi, "magnet:[redacted]");
  value = value.replace(/\b(postgres(?:ql)?):\/\/([^:\s/@]+):([^@\s/]+)@/gi, "$1://$2:[redacted]@");
  value = value.replace(
    /([?&](?:api[_-]?key|access[_-]?token|token|password|private[_-]?key|secret)=)[^&\s]+/gi,
    "$1[redacted]",
  );
  value = value.replace(
    /\b((?:api[_-]?key|access[_-]?token|authorization|password|private[_-]?key|secret|token)\s*[:=]\s*)([^,;\s]+)/gi,
    "$1[redacted]",
  );
  value = value.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]");
  return truncate(value);
}

function normalize(value, key = "", depth = 0, seen = new WeakSet()) {
  if (SENSITIVE_KEY.test(key)) return "[redacted]";
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactText(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return `[function ${value.name || "anonymous"}]`;
  if (depth >= 5) return "[maximum depth reached]";
  if (value instanceof Error) {
    if (seen.has(value)) return "[circular error]";
    seen.add(value);
    return {
      name: redactText(value.name),
      message: redactText(value.message),
      stack: value.stack ? redactText(value.stack) : undefined,
      code: normalize(value.code, "code", depth + 1, seen),
      cause: value.cause === undefined ? undefined : normalize(value.cause, "cause", depth + 1, seen),
    };
  }
  if (typeof value !== "object") return redactText(value);
  if (seen.has(value)) return "[circular]";

  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.slice(0, 50).map((item) => normalize(item, "", depth + 1, seen));
    if (value.length > 50) result.push(`[${value.length - 50} more items]`);
    return result;
  }

  const result = {};
  for (const [entryKey, entryValue] of Object.entries(value).slice(0, 50)) {
    result[entryKey] = normalize(entryValue, entryKey, depth + 1, seen);
  }
  return result;
}

export function rotateLogFile(filePath, { maxBytes = DEFAULT_MAX_BYTES, backups = DEFAULT_BACKUPS } = {}) {
  try {
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size < maxBytes) return false;
    for (let index = backups; index >= 1; index -= 1) {
      const source = index === 1 ? filePath : `${filePath}.${index - 1}`;
      const destination = `${filePath}.${index}`;
      if (!fs.existsSync(source)) continue;
      if (fs.existsSync(destination)) fs.rmSync(destination);
      fs.renameSync(source, destination);
    }
    return true;
  } catch {
    return false;
  }
}

export function installDiagnosticLogging({ logDir, appVersion, packaged, rotateLogs = true }) {
  fs.mkdirSync(logDir, { recursive: true });
  const filePath = path.join(logDir, "frontend.log");
  const errorFilePath = path.join(logDir, "errors.log");
  if (rotateLogs) rotateLogFile(filePath);
  const sessionId = crypto.randomUUID();
  const originalConsole = Object.fromEntries(
    ["debug", "log", "info", "warn", "error"].map((level) => [level, console[level].bind(console)]),
  );

  const write = (level, scope, message, details, { sourceLog = "frontend.log" } = {}) => {
    const record = {
      timestamp: new Date().toISOString(),
      level,
      process: "frontend",
      scope,
      session_id: sessionId,
      message: redactText(message),
    };
    if (level === "error") {
      record.correlation_id = crypto.randomUUID();
      record.source_log = sourceLog;
      record.stack = redactText(new Error("diagnostic callsite").stack || "");
    }
    if (details !== undefined) record.details = normalize(details);
    try {
      const line = `${JSON.stringify(record)}\n`;
      if (fs.existsSync(filePath) && fs.statSync(filePath).size + Buffer.byteLength(line) >= DEFAULT_MAX_BYTES) {
        rotateLogFile(filePath);
      }
      fs.appendFileSync(filePath, line, "utf8");
      if (level === "error") {
        // errors.log is shared with the backend; RuntimeManager rotates it only
        // immediately before a new backend opens its append-only handle.
        fs.appendFileSync(errorFilePath, line, "utf8");
      }
    } catch {
      // Logging must never take down the application or recursively log its own failure.
    }
    return record;
  };

  const levels = { debug: "debug", log: "info", info: "info", warn: "warn", error: "error" };
  for (const [consoleLevel, diagnosticLevel] of Object.entries(levels)) {
    console[consoleLevel] = (...args) => {
      originalConsole[consoleLevel](...args);
      try {
        const message = args.length > 0 && typeof args[0] === "string"
          ? util.format(...args)
          : util.inspect(args[0], { depth: 2, breakLength: Infinity });
        const details = { arguments: args };
        if (diagnosticLevel === "warn" || diagnosticLevel === "error") {
          details.callsite = new Error("console callsite").stack;
        }
        write(diagnosticLevel, "main", message, details);
      } catch {
        // Console behavior must not depend on diagnostics serialization.
      }
    };
  }

  write("info", "lifecycle", "diagnostic session started", {
    app_version: appVersion,
    electron_version: process.versions.electron,
    node_version: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    packaged,
  });

  return {
    filePath,
    sessionId,
    write,
    paths: {
      frontend: filePath,
      backend: path.join(logDir, "backend.log"),
      errors: errorFilePath,
      directory: logDir,
    },
  };
}
