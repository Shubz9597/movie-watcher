import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installDiagnosticLogging, redactText, rotateLogFile } from "../electron/diagnostics/diagnostic-logger.js";

test("redactText removes credentials and magnets", () => {
  const input = "postgres://user:password@localhost/db?api_key=secret magnet:?xt=urn:btih:abc&tr=private token=hidden";
  const output = redactText(input);

  assert.doesNotMatch(output, /password|secret|private|hidden/);
  assert.match(output, /postgres:\/\/user:\[redacted\]@localhost/);
  assert.match(output, /magnet:\[redacted\]/);
});

test("rotateLogFile keeps bounded history", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "torwatch-logs-"));
  const filePath = path.join(directory, "frontend.log");
  try {
    fs.writeFileSync(filePath, "current");
    fs.writeFileSync(`${filePath}.1`, "previous");

    assert.equal(rotateLogFile(filePath, { maxBytes: 1, backups: 2 }), true);
    assert.equal(fs.readFileSync(`${filePath}.1`, "utf8"), "current");
    assert.equal(fs.readFileSync(`${filePath}.2`, "utf8"), "previous");
    assert.equal(fs.existsSync(filePath), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("installed logger records a redacted error stack and callsite", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "torwatch-frontend-"));
  try {
    const logger = installDiagnosticLogging({ logDir: directory, appVersion: "test", packaged: false });
    console.error("request failed token=top-secret", new Error("backend unavailable"));

    const records = fs.readFileSync(logger.filePath, "utf8").trim().split("\n").map(JSON.parse);
    const failure = records.at(-1);
    assert.equal(failure.level, "error");
    assert.match(failure.details.callsite, /diagnostic-logger\.test\.mjs/);
    assert.match(failure.details.arguments[1].stack, /backend unavailable/);
    assert.doesNotMatch(JSON.stringify(failure), /top-secret/);
    assert.match(failure.correlation_id, /^[0-9a-f-]{36}$/);
    assert.equal(failure.source_log, "frontend.log");

    const errorRecords = fs.readFileSync(logger.paths.errors, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(errorRecords.length, 1);
    assert.equal(errorRecords[0].correlation_id, failure.correlation_id);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("error records can link to backend diagnostics", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "torwatch-backend-link-"));
  try {
    const logger = installDiagnosticLogging({ logDir: directory, appVersion: "test", packaged: false });
    const record = logger.write("error", "backend-process", "backend exited", { code: 1 }, { sourceLog: "backend.log" });

    assert.equal(record.source_log, "backend.log");
    const indexed = JSON.parse(fs.readFileSync(logger.paths.errors, "utf8").trim());
    assert.equal(indexed.correlation_id, record.correlation_id);
    assert.equal(indexed.source_log, "backend.log");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
