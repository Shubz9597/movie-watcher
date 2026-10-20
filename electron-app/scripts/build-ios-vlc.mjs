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
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

const VLC_REMOTES = ['https://code.videolan.org/videolan/vlc.git', 'https://github.com/videolan/vlc.git'];
// Build tools whose own download sites fail: VideoLAN no longer has its
// copy of yasm 1.3.0 and tortall.net answers intermittently. Checked
// against VLC's own SHA512SUMS before use.
const TOOL_MIRRORS = {
  'yasm-1.3.0.tar.gz': [
    'https://github.com/yasm/yasm/releases/download/v1.3.0/yasm-1.3.0.tar.gz',
    'https://ftp.osuosl.org/pub/blfs/conglomeration/yasm/yasm-1.3.0.tar.gz',
    'http://www.tortall.net/projects/yasm/releases/yasm-1.3.0.tar.gz',
  ],
};
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

// Prerequisites. xcodebuild fails with Xcode installed when the command
// line tools point at Apple's separate Command Line Tools, or before the
// license is accepted: say which, with the command that fixes it.
const xcode = spawnSync('xcodebuild', ['-version'], { encoding: 'utf8' });
if (xcode.status !== 0) {
  const reason = `${xcode.stderr || ''}${xcode.stdout || ''}`.trim();
  const developerDir = output('xcode-select', ['-p']);
  if (/command line tools instance|requires Xcode/i.test(reason) || developerDir.includes('CommandLineTools')) {
    fail(`The command line tools point at ${developerDir || 'Command Line Tools'}, not Xcode. Run:\n` +
      '  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer\n' +
      'then npm run build:ios-vlc again.');
  }
  if (/license/i.test(reason)) fail('Accept the Xcode license: sudo xcodebuild -license accept');
  fail(`xcodebuild does not run${reason ? `:\n${reason}` : ''}\nInstall Xcode from the App Store, open it once, then run:\n` +
    '  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer');
}
say(xcode.stdout.split('\n')[0]);
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

// VLC's source, as VLCKit's script would fetch it (it then resets it to
// the tested commit and applies the patches): fetched here so that build
// tools whose download sites fail can be put in place first.
const vlc = path.join(work, 'libvlc', 'vlc');
if (!existsSync(path.join(vlc, '.git'))) {
  mkdirSync(path.dirname(vlc), { recursive: true });
  let cloned = false;
  for (const remote of VLC_REMOTES) {
    say(`Downloading VLC from ${remote}`);
    rmSync(vlc, { recursive: true, force: true });
    if (spawnSync('git', ['clone', remote, '--branch', '3.0.x', '--single-branch', vlc], { stdio: 'inherit' }).status === 0) {
      cloned = true;
      break;
    }
  }
  if (!cloned) fail('VLC could not be downloaded. Check the internet connection and retry.');
}
await fetchToolMirrors(path.join(vlc, 'extras', 'tools'));
installDownloadFallback(path.join(vlc, 'extras', 'tools', 'build', 'bin'));
// An interrupted download can leave an empty file the build would take as done.
for (const dir of [path.join(vlc, 'extras', 'tools'), path.join(vlc, 'contrib', 'tarballs')]) {
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (/\.(tar\.(gz|bz2|xz)|tgz|zip)$/.test(name) && statSync(file).size === 0) rmSync(file);
  }
}

// VideoLAN's build: VLC (on first run from its own git), its libraries, then
// MobileVLCKit.xcframework for iPhone and the simulator.
say('Building MobileVLCKit with the TorWatch patch. The first build takes 1-2 hours.');
// Keep the Mac from sleeping while it builds (the screen may still turn off
// and lock; a closed MacBook lid still sleeps it).
spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).unref();
const started = Date.now();
adaptXcodeStep(path.join(work, 'buildMobileVLCKit.sh'));
// VLC compiled with our patch already (an earlier run that stopped at the
// Xcode step): only redo the framework, in minutes.
const compiled = ['install-iPhoneOS/arm64', 'install-iPhoneSimulator/arm64', 'install-iPhoneSimulator/x86_64']
  .map((slice) => path.join(vlc, slice, 'lib', 'libvlc.a'))
  .every((lib) => existsSync(lib) && output('nm', ['-g', lib]).includes('libvlc_video_set_subtitle_layout'));
if (compiled) say('VLC is already compiled with the TorWatch patch: building the framework only.');
run('./buildMobileVLCKit.sh', compiled ? ['-f', '-l'] : ['-f'], { cwd: work, env: { ...process.env, LC_ALL: 'C' } });
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

async function fetchToolMirrors(toolsDir) {
  let sums = '';
  try { sums = readFileSync(path.join(toolsDir, 'SHA512SUMS'), 'utf8'); } catch { return; }
  for (const [file, urls] of Object.entries(TOOL_MIRRORS)) {
    const expected = sums.split('\n').map((line) => line.trim().split(/\s+/)).find(([, name]) => name === file)?.[0];
    const target = path.join(toolsDir, file);
    if (!expected) continue;
    if (existsSync(target) && createHash('sha512').update(readFileSync(target)).digest('hex') === expected) continue;
    let placed = false;
    for (const url of urls) {
      try {
        const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
        if (!response.ok) continue;
        const data = Buffer.from(await response.arrayBuffer());
        if (createHash('sha512').update(data).digest('hex') !== expected) continue;
        writeFileSync(target, data);
        say(`${file}: from ${new URL(url).host}`);
        placed = true;
        break;
      } catch {
        // Try the next mirror.
      }
    }
    if (!placed) say(`${file}: no mirror answered; VLC's build will try its own sources.`);
  }
}

// VLC's build downloads its tools and libraries with curl. The Mac's curl
// (LibreSSL) fails to connect to some hosts on some networks (GitHub release
// files: "tlsv1 alert protocol version"), so a curl placed first on the
// build's PATH (VLC's own tools folder) runs the real one and, when that
// fails, fetches the same URL with Node. VLC still checks every file
// against its SHA512SUMS.
function installDownloadFallback(binDir) {
  mkdirSync(binDir, { recursive: true });
  const helper = path.join(binDir, 'torwatch-download.mjs');
  writeFileSync(helper, `// Fetches URL into FILE (following redirects), for the curl fallback.
import { writeFileSync } from 'node:fs';
const [url, file] = process.argv.slice(2);
for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(600000) });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    console.error('[ios-vlc] fetched with Node: ' + url);
    process.exit(0);
  } catch (error) {
    if (attempt === 3) { console.error('[ios-vlc] Node could not fetch ' + url + ': ' + error.message); process.exit(1); }
  }
}
`);
  const shim = path.join(binDir, 'curl');
  writeFileSync(shim, `#!/bin/sh
# TorWatch: the system curl first; if it fails, the same download with Node.
/usr/bin/curl "$@" && exit 0
status=$?
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o|--output) out="$2"; shift 2 ;;
    --retry|--max-time|-m|--connect-timeout|-H|--header|-A|--user-agent) shift 2 ;;
    --) url="$2"; shift $# ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
[ -n "$out" ] && [ -n "$url" ] || exit $status
"${process.execPath}" "${helper}" "$url" "$out" || exit $status
`);
  chmodSync(shim, 0o755);
}

// VLCKit 3.7.3's framework step targets iOS 9 and signs with "iPhone
// Developer": current Xcode cannot link ARC code for iOS < 11 (libarclite is
// gone) and needs a team to sign. Target the app's iOS 15 without signing
// (Xcode signs the framework when it embeds it in the app), and show
// Xcode's own error instead of discarding its output.
function adaptXcodeStep(script) {
  let text = readFileSync(script, 'utf8');
  text = text.replace(/IPHONEOS_DEPLOYMENT_TARGET=\$\{SDK_MIN\} \\\n/,
    'IPHONEOS_DEPLOYMENT_TARGET=15.0 CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY= \\\n');
  text = text.replace(/SKIP_INSTALL=no \\\n\s*> \$\{out\}\n/,
    'SKIP_INSTALL=no \\\n' +
    '               > "${ROOT_DIR}/xcodebuild-$PLATFORM.log" 2>&1 || { grep -E "error:|ARCHIVE FAILED" "${ROOT_DIR}/xcodebuild-$PLATFORM.log" | tail -40; ' +
    'echo "Xcode log: ${ROOT_DIR}/xcodebuild-$PLATFORM.log"; exit 1; }\n');
  if (!text.includes('IPHONEOS_DEPLOYMENT_TARGET=15.0') || !text.includes('xcodebuild-$PLATFORM.log')) {
    fail('VLCKit\'s build script changed; its Xcode step could not be adapted.');
  }
  writeFileSync(script, text);
}
