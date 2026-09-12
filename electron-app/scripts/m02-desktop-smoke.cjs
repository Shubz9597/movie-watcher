// M0.2 interactive-desktop-smoke surrogate (Windows, headless-safe).
//
// This is REAL Electron: the Electron binary starts, a real BrowserWindow
// loads the real production renderer bundle (dist/index.html), and the shared
// React UI runs against a REAL Go backend (the M0.2 staging instance on
// 127.0.0.1:4002, deterministic provider stub upstream). It drives:
//   Home (trending + recommendation row) -> search -> title detail ->
//   Library toggle write (server-confirmed) -> Library page -> app restart
//   -> library state restored from the server.
//
// What this is NOT: it does not run main.js's startup controller (that gates
// on a TMDb credential and would spawn the Docker infrastructure), and it
// does NOT exercise MPV playback, torrent source selection, subtitles, seek,
// or resume positions. Those need a real provider/source and are recorded in
// the M0.2 evidence as operator/hardware remaining.
//
// Usage: electron scripts/m02-desktop-smoke.cjs
// Result JSON: deploy/desktop-staging/logs/m02-smoke-result.json (written by
// the orchestrator via stdout parsing is avoided; this file logs PASS/FAIL
// lines and exits non-zero on failure).
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const distIndex = path.join(__dirname, '..', 'dist', 'index.html');
const screenshotDir = path.join(__dirname, '..', 'release', 'm02');

const results = [];
function record(ok, name, detail) {
  results.push({ ok, name, detail: detail || '' });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(win, fnBody, timeoutMs, pollMs = 200) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await win.webContents.executeJavaScript(`Boolean(${fnBody})`)) return true;
    } catch (error) { lastError = error; }
    await sleep(pollMs);
  }
  throw new Error(`waitFor timed out: ${fnBody}${lastError ? ` (last: ${lastError.message})` : ''}`);
}

async function launchWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#111214', symbolColor: '#dadbdf', height: 40 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // Harness shim (scripts/m02-smoke-preload.cjs): satisfies the catalog
      // gate so the shared UI runs against the M0.2 backend. The REAL app
      // reaches the same state through its TMDb credential flow.
      preload: path.join(__dirname, 'm02-smoke-preload.cjs'),
    },
  });
  // Electron 44 emits console-message as an Event<params> object whose level
  // may be a string; log warnings and errors regardless of representation.
  win.webContents.on('console-message', (e) => {
    const level = e.level;
    const numeric = typeof level === 'number' ? level : { debug: 0, info: 0, warning: 2, error: 3 }[String(level)] ?? 0;
    if (numeric >= 2) console.log(`RENDERER_CONSOLE=${e.message}`);
  });
  // Transient Windows file locks can fail a load with ERR_FAILED (-2);
  // retry a bounded number of times before giving up.
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await win.loadFile(distIndex);
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      await sleep(1_500);
    }
  }
  if (lastError) throw lastError;
  return win;
}

async function runSmoke() {
  fs.mkdirSync(screenshotDir, { recursive: true });
  const shot = async (win, name) => {
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(screenshotDir, `${name}.png`), image.toPNG());
  };

  // --- First app run -------------------------------------------------------
  const win = await launchWindow();
  await waitFor(win, `document.querySelector('#root')?.children.length > 0`, 20_000);
  record(true, 'Electron started and the renderer bundle mounted');

  // Catalog through BFF: stub trending rows must render on Home.
  try {
    await waitFor(win, `document.body.innerText.includes('Staging Popular')`, 20_000);
    record(true, 'Home renders BFF catalog sections (stub-backed trending)', 'Staging Popular One/Two/Three');
  } catch {
    const dump = await win.webContents.executeJavaScript(
      `document.body.innerText.slice(0, 400) + ' ||| rootHTML: ' + (document.querySelector('#root')?.innerHTML.slice(0, 400) || 'EMPTY')`)
      .catch((e) => `dump failed: ${e.message}`);
    record(false, 'Home renders BFF catalog sections (stub-backed trending)', dump);
    await shot(win, 'm02-fail-home');
  }
  await shot(win, 'm02-home');

  // Recommendation row capability-gated: library capability available -> the
  // row renders (empty/Popular fallback is truthful before any favourites).
  const recRow = await win.webContents.executeJavaScript(
    `document.body.innerText.includes('Recommended') || document.body.innerText.includes('Popular picks')`);
  record(Boolean(recRow), 'Home renders the recommendations surface (capability-gated)', recRow ? 'row present' : 'row absent');

  // Search: open the global search, type, results must appear (cmdk).
  await win.webContents.executeJavaScript(
    `(() => {
      const input = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || '').includes('Search titles'));
      if (input) input.click();
      return Boolean(input);
    })()`);
  await sleep(400);
  const searchOpen = await waitFor(win, `Boolean(document.querySelector('input[placeholder*=\"Search\"]'))`, 10_000)
    .then(() => true).catch(() => false);
  record(searchOpen, 'Global search dialog opens');

  if (searchOpen) {
    await win.webContents.executeJavaScript(`(() => {
      const el = document.querySelector('input[placeholder*="Search"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, 'staging');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    try {
      await waitFor(win, `[...document.querySelectorAll('[cmdk-item]')].length > 0`, 20_000);
      const labels = await win.webContents.executeJavaScript(
        `[...document.querySelectorAll('[cmdk-item]')].map(n => n.textContent.trim()).slice(0, 4).join(' | ')`);
      record(true, 'Search returns BFF results (stub-backed)', labels);
      await shot(win, 'm02-search');
      await win.webContents.executeJavaScript(
        `document.querySelector('[cmdk-item]').dispatchEvent(new MouseEvent('click', { bubbles: true })); true`);
    } catch (error) {
      record(false, 'Search returns BFF results (stub-backed)', error.message);
    }
  }

  // Title detail: qualified id + Library toggle reachable.
  try {
    await waitFor(win, `Boolean([...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || '').includes('Favourite')))`, 20_000);
    const toggle = await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || '').includes('Favourite'))?.getAttribute('aria-label')`);
    record(true, 'Title page renders with an available Library toggle', toggle);
    await shot(win, 'm02-title');
    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Mark as Favourite')?.click(); true`);
    await waitFor(win, `Boolean([...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Remove from Favourites'))`, 15_000);
    record(true, 'Library favourite write from the desktop UI confirmed (Remove state rendered)');
  } catch (error) {
    record(false, 'Title page Library toggle flow', error.message);
    await shot(win, 'm02-fail-title');
  }

  // Library page renders the server-confirmed item.
  await win.webContents.executeJavaScript(`window.location.hash = '#library?collection=favourites&sort=recent'; true`);
  try {
    await waitFor(win, `document.body.innerText.includes('Staging')`, 20_000);
    record(true, 'Library page renders the favourite (server-backed)');
    await shot(win, 'm02-library');
  } catch (error) {
    record(false, 'Library page renders the favourite (server-backed)', error.message);
    await shot(win, 'm02-fail-library');
  }

  // Source selection surface: with no Prowlarr in staging the title must
  // render its TRUTHFUL empty/degraded source state (no fabricated rows).
  await win.webContents.executeJavaScript(`window.location.hash = '#title?kind=movie&id=101'; true`);
  await sleep(2500);
  const sourceText = await win.webContents.executeJavaScript(`document.body.innerText.slice(0, 2500)`);
  const fabricatesSources = /magnet:|Download\s+seeders/i.test(sourceText);
  record(!fabricatesSources, 'Source-selection surface renders no fabricated sources', 'no magnet/seeders rows without a provider');
  await shot(win, 'm02-title-sources-empty');

  win.destroy();

  // --- Second app run (restart) --------------------------------------------
  const win2 = await launchWindow();
  await waitFor(win2, `document.querySelector('#root')?.children.length > 0`, 20_000);
  record(true, 'Second app start: renderer mounted again');
  await win2.webContents.executeJavaScript(`window.location.hash = '#library?collection=favourites&sort=recent'; true`);
  try {
    await waitFor(win2, `document.body.innerText.includes('Staging')`, 20_000);
    record(true, 'Restart: library state restored from the server (persistence)');
    await shot(win2, 'm02-restart-library');
  } catch (error) {
    record(false, 'Restart: library state restored from the server (persistence)', error.message);
    await shot(win2, 'm02-fail-restart');
  }
  win2.destroy();

  const failed = results.filter((r) => !r.ok);
  console.log(`\nM0.2 desktop smoke: ${results.length - failed.length}/${results.length} checks passed` +
    (failed.length ? ` — FAILURES: ${failed.map((f) => f.name).join('; ')}` : ''));
  console.log('M0.2 RESULT JSON: ' + JSON.stringify(results));
  app.exit(failed.length ? 1 : 0);
}

app.whenReady().then(() => {
  // Prevent the DEFAULT window-all-closed auto-quit: the smoke destroys the
  // first window before launching the second (restart) run. Without this the
  // app quits mid-smoke and the restart phase silently never runs.
  app.on('window-all-closed', () => {});
  runSmoke().catch(async (error) => {
    console.error('M02_SMOKE_ERROR=' + (error && error.stack || error));
    record(false, 'smoke crashed', String(error && error.message || error));
    console.log('M0.2 RESULT JSON: ' + JSON.stringify(results));
    app.exit(1);
  });
});
