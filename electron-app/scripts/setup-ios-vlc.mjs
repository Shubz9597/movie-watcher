// Install the pinned official binary without editing Capacitor's generated SPM package.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, rename, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

if (process.platform !== 'darwin') {
  console.log('[ios-vlc] Run npm run setup:ios-vlc on the Mac before opening Xcode.');
  process.exit(0);
}
const root = fileURLToPath(new URL('../ios/App/VLCDependency/', import.meta.url));
const framework = path.join(root, 'MobileVLCKit.xcframework');
const archive = path.join(root, 'MobileVLCKit.tar.xz');
const staging = path.join(root, '.extract');
const url = 'https://download.videolan.org/pub/cocoapods/prod/MobileVLCKit-3.7.3-319ed2c0-79128878.tar.xz';
const checksum = '0d04059906962ddc9a7bd1ebaa12e1f9ae85eb2466116a97a2f46886dd27a0a9';
try {
  await access(path.join(framework, 'Info.plist'));
  console.log('[ios-vlc] MobileVLCKit 3.7.3 is installed.');
} catch {
  await mkdir(root, { recursive: true });
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(600000) });
    if (!response.ok || !response.body) throw new Error(`VideoLAN download failed (${response.status}).`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    if (hash.digest('hex') !== checksum) throw new Error('MobileVLCKit checksum mismatch.');
    await mkdir(staging, { recursive: true });
    execFileSync('tar', ['-xf', archive, '-C', staging], { stdio: 'inherit' });
    await access(path.join(staging, 'MobileVLCKit.xcframework', 'Info.plist'));
    await rename(path.join(staging, 'MobileVLCKit.xcframework'), framework);
    console.log('[ios-vlc] Installed verified MobileVLCKit 3.7.3.');
  } finally {
    await rm(archive, { force: true });
    await rm(staging, { recursive: true, force: true });
  }
}
