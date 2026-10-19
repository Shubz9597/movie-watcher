import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { listPackage, extractFile } from '@electron/asar';

export function verifyWindowsPackage(unpackedDirectory) {
  const archive = path.join(unpackedDirectory, 'resources', 'app.asar');
  const entries = new Set(listPackage(archive).map((entry) => entry.replaceAll('\\', '/').replace(/^\//, '')));
  assert.ok(entries.has('backend-origin.mjs'), 'backend-origin.mjs must be shipped for the main-process import');
  for (const file of entries) {
    if (!(file === 'main.js' || file.startsWith('electron/')) || !/\.(?:js|mjs|cjs)$/.test(file)) continue;
    const source = extractFile(archive, path.normalize(file)).toString('utf8');
    const imports = source.matchAll(/(?:from\s*|import\s*|require\(\s*)["'](\.[^"']+)["']/g);
    for (const match of imports) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
      assert.ok(entries.has(target), `${file} imports missing packaged file ${target}`);
    }
  }
  assert.ok(fs.existsSync(path.join(unpackedDirectory, 'resources', 'desktop-server-guide.html')));
  const metadata = JSON.parse(extractFile(archive, 'package.json').toString('utf8'));
  assert.equal(metadata.version, process.env.TORWATCH_DESKTOP_VERSION || '2.0.2');
  console.log('WINDOWS_PACKAGE_IMPORTS=PASS (main-process imports, guide and desktop version)');
}

if (process.argv[2]) verifyWindowsPackage(path.resolve(process.argv[2]));
