// Regression tests for the staging frontend server (run standalone:
//   node --test deploy/desktop-staging/serve-browser.test.mjs
// from the repository root). They start the REAL server on an ephemeral port
// against a temporary dist directory and assert the safety properties:
// path-traversal rejection, SPA-shell semantics, and truthful asset 404s.
import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "serve-browser.mjs");

// Raw request WITHOUT client-side dot-segment normalization: fetch/WHATWG-URL
// rewrites "/%2e%2e/..." before it ever reaches the server, which would hide
// server-side guard bugs. node:http sends the path verbatim.
function rawGet(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });
}

function startServer(dist) {
  const child = spawn(process.execPath, [script, "--port", "0"], {
    env: { ...process.env, SERVE_BROWSER_DIST: dist },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    const fail = setTimeout(() => reject(new Error("server did not announce")), 5000);
    child.stdout.on("data", (chunk) => {
      const match = String(chunk).match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(fail);
        resolve({ child, port: Number(match[1]) });
      }
    });
    child.on("exit", (code) => reject(new Error(`server exited early (${code})`)));
  });
}

test("serve-browser rejects traversal, serves the shell, and 404s missing assets", async () => {
  const dist = mkdtempSync(join(tmpdir(), "serve-browser-test-"));
  writeFileSync(join(dist, "browser.html"), "<html>shell</html>");
  writeFileSync(join(dist, "app.js"), "console.log(1)");
  mkdirSync(join(dist, "secret"));
  writeFileSync(join(dist, "secret", "key.txt"), "do-not-serve");

  const { child, port } = await startServer(dist);
  try {
    const get = async (path) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      return { status: res.status, body: await res.text() };
    };

    const shell = await get("/browser.html");
    assert.equal(shell.status, 200);
    assert.ok(shell.body.includes("shell"));

    const asset = await get("/app.js");
    assert.equal(asset.status, 200);

    const shellFallback = await get("/some/unknown/route");
    assert.equal(shellFallback.status, 200, "extension-less unknown paths fall back to the SPA shell");

    const missingAsset = await get("/missing-bundle.js");
    assert.equal(missingAsset.status, 404, "a missing extension-bearing asset is a truthful 404, not the shell");

    const traversal = await rawGet(port, "/..%2f..%2fREADME.md");
    assert.equal(traversal.status, 403, "encoded-slash traversal is rejected");

    const nested = await rawGet(port, "/secret%2f..%2f..%2fsecret%2fkey.txt");
    assert.equal(nested.status, 403, "nested encoded-slash traversal out of dist is rejected");

    // WHATWG URL normalizes %2e dot-segments before application code runs, so
    // that request ARRIVES as /secret/key.txt (in-dist) and is served. This
    // documents why the %2f boundary check above is the real guard.
    const dotSegments = await rawGet(port, "/%2e%2e/secret/key.txt");
    assert.equal(dotSegments.status, 200);

    const plain = await rawGet(port, "/secret/key.txt");
    assert.equal(plain.status, 200, "files inside dist remain servable");

    const malformed = await rawGet(port, "/%zz");
    assert.equal(malformed.status, 400, "malformed percent-encoding is a 400, not a server crash");
  } finally {
    child.kill();
  }
});

test("serve-browser refuses to start without a built dist", async () => {
  const empty = mkdtempSync(join(tmpdir(), "serve-browser-empty-"));
  const child = spawn(process.execPath, [script, "--port", "0"], {
    env: { ...process.env, SERVE_BROWSER_DIST: empty },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 1, "missing browser.html is a clear startup failure");
});
