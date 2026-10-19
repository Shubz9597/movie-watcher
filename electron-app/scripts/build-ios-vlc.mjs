// Builds MobileVLCKit 3.7.3 with TorWatch's VLC patch (subtitle box for
// dialogue tracks, live subtitle lift and size) and puts it where the app
// takes MobileVLCKit from. Mac only; the first build takes 1-2 hours and
// about 20 GB in ~/Library/Caches/TorWatch (later builds reuse it).
//
//   npm run build:ios-vlc              build and install the patched framework
//   npm run build:ios-vlc -- --stock   go back to VideoLAN's official framework
//
// The build is VideoLAN's own (buildMobileVLCKit.sh -f, as their releases):
// VLCKit 3.7.3 at 319ed2c0 on VLC 79128878 with VLCKit's 47 patches, plus
// ios/App/VLCDependency/patches/0048-*.patch. After installing, use Xcode's
// Product > Clean Build Folder once.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VLCKIT_COMMIT = '319ed2c0724e3d4c4d34889a62fef1ae269491bc'; // VLCKit 3.7.3
const VLCKIT_REMOTES = ['https://code.videolan.org/videolan/VLCKit.git', 'https://github.com/videolan/vlckit.git'];
const dependency = fileURLToPath(new URL('../ios/App/VLCDependency/', import.meta.url));
const installed = path.join(dependency, 'MobileVLCKit.xcframework');
const stock = path.join(dependency, 'MobileVLCKit.stock.xcframework');
const marker = 'TORWATCH-PATCHED';
const work = path.join(homedir(), 'Library', 'Caches', 'TorWatch', 'vlckit-3.7.3');

const say = (text) => console.log(`[ios-vlc] ${text}`);
const fail = (text) => { console.error(`[ios-vlc] ${text}`); process.exit(1); };
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.status !== 0) fail(`${command} ${args.join(' ')} failed (exit ${result.status}).`);
};
const output = (command, args) => {
  try { return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
};

if (process.platform !== 'darwin') fail('Run this on the Mac (it needs Xcode).');

// --stock: back to VideoLAN's framework.
if (process.argv.includes('--stock')) {
  if (!existsSync(path.join(installed, marker))) {
    say('The official framework is already in place.');
    process.exit(0);
  }
  rmSync(installed, { recursive: true, force: true });
  if (existsSync(stock)) {
    renameSync(stock, installed);
    say('Restored the official MobileVLCKit. In Xcode: Product > Clean Build Folder, then Run.');
  } else {
    say('Removed the patched framework; run npm run setup:ios-vlc to download the official one.');
  }
  process.exit(0);
}

// Prerequisites.
if (!output('xcodebuild', ['-version'])) fail('Install Xcode (and open it once to finish its setup).');
if (!output('xcode-select', ['-p'])) fail('Run: xcode-select --install');
if (!output('git', ['--version'])) fail('Install git (Xcode command line tools).');
if (!output('python3', ['--version'])) fail('Install python3 (Xcode command line tools).');

const patches = readdirSync(path.join(dependency, 'patches')).filter((name) => /^\d{4}-.*\.patch$/.test(name));
if (!patches.length) fail('No patch found in ios/App/VLCDependency/patches.');
const patchHash = createHash('sha256');
for (const name of patches.sort()) patchHash.update(readFileSync(path.join(dependency, 'patches', name)));
const fingerprint = `${VLCKIT_COMMIT}\n${patchHash.digest('hex')}\n`;

if (existsSync(path.join(installed, marker)) && readFileSync(path.join(installed, marker), 'utf8') === fingerprint) {
  say('The patched MobileVLCKit is already installed and up to date.');
  process.exit(0);
}

// VLCKit's source at 3.7.3.
mkdirSync(path.dirname(work), { recursive: true });
if (!existsSync(path.join(work, '.git'))) {
  let cloned = false;
  for (const remote of VLCKIT_REMOTES) {
    say(`Downloading VLCKit from ${remote}`);
    rmSync(work, { recursive: true, force: true });
    if (spawnSync('git', ['clone', remote, work], { stdio: 'inherit' }).status === 0) { cloned = true; break; }
  }
  if (!cloned) fail('VLCKit could not be downloaded. Check the internet connection and retry.');
}
run('git', ['-C', work, 'fetch', '--quiet', 'origin'], { stdio: 'ignore' });
run('git', ['-C', work, 'checkout', '--quiet', '--force', VLCKIT_COMMIT]);
// Our patches go after VLCKit's own (its script applies them all with git am).
for (const name of readdirSync(path.join(work, 'libvlc', 'patches'))) {
  if (/^\d{4}-torwatch-/.test(name)) rmSync(path.join(work, 'libvlc', 'patches', name));
}
for (const name of patches) cpSync(path.join(dependency, 'patches', name), path.join(work, 'libvlc', 'patches', name));

// VideoLAN's build: VLC (on first run from its own git), its libraries, then
// MobileVLCKit.xcframework for iPhone and the simulator.
say('Building MobileVLCKit with the TorWatch patch. The first build takes 1-2 hours; leave the Mac awake.');
const started = Date.now();
run('./buildMobileVLCKit.sh', ['-f'], { cwd: work, env: { ...process.env, LC_ALL: 'C' } });
const built = path.join(work, 'build', 'MobileVLCKit.xcframework');
if (!existsSync(path.join(built, 'Info.plist'))) fail('The build finished without MobileVLCKit.xcframework; see the output above.');

// The new subtitle function must be in every slice.
for (const slice of readdirSync(built).filter((name) => !name.endsWith('.plist'))) {
  const binary = path.join(built, slice, 'MobileVLCKit.framework', 'MobileVLCKit');
  if (!existsSync(binary)) continue;
  if (!output('nm', ['-g', binary]).includes('libvlc_video_set_subtitle_layout')) {
    fail(`The ${slice} build lacks libvlc_video_set_subtitle_layout: the TorWatch patch was not applied.`);
  }
}

// Install, keeping the official framework for --stock.
if (existsSync(installed) && !existsSync(path.join(installed, marker))) {
  rmSync(stock, { recursive: true, force: true });
  renameSync(installed, stock);
}
rmSync(installed, { recursive: true, force: true });
cpSync(built, installed, { recursive: true, verbatimSymlinks: true });
writeFileSync(path.join(installed, marker), fingerprint);
const minutes = Math.round((Date.now() - started) / 60000);
say(`Installed the patched MobileVLCKit (${minutes} min). In Xcode: Product > Clean Build Folder, then Run.`);
say('To go back: npm run build:ios-vlc -- --stock');
