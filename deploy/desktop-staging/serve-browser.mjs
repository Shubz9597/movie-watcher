// Staging frontend server (Windows desktop staging, repair-pass hygiene):
// serves the REAL production browser build (dist-browser) on 127.0.0.1 only.
// Not fixture mode - this is the shipped build with the exact backend origin
// baked into its CSP at build time.
//
// Safety properties:
// - Binds 127.0.0.1 only (private; Tailscale Serve may proxy it privately).
// - Static files from dist-browser only; path traversal is rejected.
// - SPA fallback serves browser.html for unknown paths (hash routing needs
//   only the shell, but deep /browser.html?... loads are covered).
// - No directory listing, no write endpoints, no proxying.
import http from "node:http";
import { stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const appDirectory = path.resolve(scriptDirectory, "..", "..", "electron-app");
// Production staging always serves the real build. The environment override
// exists ONLY for the regression test (serve-browser.test.mjs) so it can run
// against a temporary dist without touching the real one.
const distDirectory = process.env.SERVE_BROWSER_DIST
  ? path.resolve(process.env.SERVE_BROWSER_DIST)
  : path.resolve(appDirectory, "dist-browser");
const shell = path.join(distDirectory, "browser.html");

function readOption(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const port = Number(readOption("--port", "4174"));
// Port 0 (ephemeral, used by the regression test) is valid; any other
// out-of-range value is a configuration error.
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error("[staging-frontend] invalid --port");
  process.exit(1);
}
if (!existsSync(shell)) {
  console.error("[staging-frontend] dist-browser/browser.html not found. Run `npm run build:browser` in electron-app first (the staging harness does this).");
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  let pathname;
  try {
    // Malformed percent-sequences (e.g. "/%zz") throw; that must be a 400,
    // never an uncaught exception in the server process.
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  let filePath = path.join(distDirectory, pathname);
  // Path traversal guard: the resolved path must stay INSIDE dist-browser
  // (a bare startsWith would accept sibling directories such as
  // "dist-browser-evil"; the separator boundary is required).
  const contained = filePath === distDirectory ||
    filePath.startsWith(distDirectory + path.sep);
  if (!contained) {
    res.writeHead(403);
    res.end();
    return;
  }
  const send = (p, status = 200) => {
    res.writeHead(status, {
      "Content-Type": MIME[path.extname(p)] ?? "application/octet-stream",
      "Cache-Control": path.extname(p) === ".html" ? "no-store" : "public, max-age=3600",
    });
    const stream = createReadStream(p);
    // A file that disappears between stat and open must not crash the server.
    stream.on("error", () => {
      if (!res.headersSent) { res.writeHead(404); }
      res.end();
    });
    stream.pipe(res);
  };
  const wantsShell = !path.extname(url.pathname);
  stat(filePath).then((info) => {
    if (!info.isFile()) {
      if (wantsShell) send(shell);
      else { res.writeHead(404); res.end(); }
    } else send(filePath);
  }).catch(() => {
    // Hash routing needs the shell; a missing extension-bearing asset is a
    // genuine 404 (returning HTML for a missing .js would mask broken builds).
    if (wantsShell) send(shell);
    else { res.writeHead(404); res.end(); }
  });
});

// localhost only: Tailscale Serve (optional) is the private tailnet gateway.
server.listen(port, "127.0.0.1", () => {
  const bound = server.address().port;
  console.log(`[staging-frontend] serving dist-browser on http://127.0.0.1:${bound}`);
});
