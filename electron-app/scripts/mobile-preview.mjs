import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const appDirectory = path.resolve(scriptDirectory, '..');
const viteEntry = path.join(appDirectory, 'node_modules', 'vite', 'bin', 'vite.js');

function readOption(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function readInteger(name, fallback, minimum, maximum) {
  const value = Number(readOption(name, String(fallback)));
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

const live = process.argv.includes('--live');
const fixture = readOption('--fixture', 'ok');
const serverOrigin = readOption('--server', 'http://localhost:4001');
const port = readInteger('--port', 5173, 1, 65535);
const width = readInteger('--width', 390, 240, 2000);
const height = readInteger('--height', 844, 320, 3000);

if (!existsSync(viteEntry)) {
  throw new Error('Vite is not installed. Run `npm install` in electron-app first.');
}

const query = live
  ? `server=${encodeURIComponent(serverOrigin)}`
  : `fixtures=${encodeURIComponent(fixture)}`;
const previewUrl = `http://127.0.0.1:${port}/browser.html?${query}`;

const vite = spawn(
  process.execPath,
  [viteEntry, '--config', 'vite.config.browser.mts', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  {
    cwd: appDirectory,
    env: { ...process.env, BROWSER: 'none' },
    stdio: 'inherit',
  },
);

let browser;
let stopping = false;

async function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;

  if (browser?.connected) {
    await browser.close().catch(() => {});
  }
  if (!vite.killed) {
    vite.kill('SIGTERM');
  }
  process.exitCode = exitCode;
}

function waitForPreview(timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let timer;

    const onViteExit = (code) => {
      clearTimeout(timer);
      reject(new Error(`Vite exited before the preview was ready (exit code ${code ?? 'unknown'}).`));
    };
    vite.once('exit', onViteExit);

    const attempt = async () => {
      try {
        const response = await fetch(previewUrl);
        if (response.ok) {
          vite.off('exit', onViteExit);
          resolve();
          return;
        }
      } catch {
        // The server normally refuses connections during its first few polls.
      }

      if (Date.now() - startedAt >= timeoutMs) {
        vite.off('exit', onViteExit);
        reject(new Error(`Timed out waiting for ${previewUrl}.`));
        return;
      }
      timer = setTimeout(attempt, 200);
    };

    void attempt();
  });
}

process.once('SIGINT', () => void stop(0));
process.once('SIGTERM', () => void stop(0));

try {
  await waitForPreview();
  const { default: puppeteer } = await import('puppeteer');
  browser = await puppeteer.launch({
    headless: false,
    defaultViewport: {
      width,
      height,
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
    },
    args: [
      `--window-size=${width + 24},${height + 140}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  const [page] = await browser.pages();
  await page.goto(previewUrl, { waitUntil: 'domcontentloaded' });

  console.log(`\nMobile preview: ${previewUrl}`);
  console.log(`Viewport: ${width}x${height} with touch emulation`);
  console.log(live
    ? `Mode: live backend (${serverOrigin})`
    : `Mode: fixture (${fixture}); no backend required`);
  console.log('Edit files normally; Vite hot reload will update this window.');
  console.log('Close the browser window or press Ctrl+C to stop.\n');

  await new Promise((resolve) => browser.once('disconnected', resolve));
  await stop(0);
} catch (error) {
  console.error(`\nCould not start the mobile preview: ${error instanceof Error ? error.message : String(error)}`);
  await stop(1);
}
