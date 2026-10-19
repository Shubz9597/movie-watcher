import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

const project = fileURLToPath(new URL('../', import.meta.url));
const repository = path.resolve(project, '..');
const output = path.join(project, 'release');
const version = process.env.TORWATCH_DESKTOP_VERSION || '2.0.1';
const installerName = `TorWatch Setup ${version}.exe`;
const installer = path.join(output, installerName);
if (!fs.existsSync(installer)) throw new Error(`Build the Windows installer first: ${installerName}`);
const stage = path.join(output, `.windows-bundle-${randomUUID()}`);
const temporaryZip = path.join(output, `TorWatch Windows ${version}.building.zip`);
const finalZip = path.join(output, `TorWatch Windows ${version}.zip`);
const serverDirectory = path.join(stage, 'LocalServer');
const copy = (source, destination) => {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
};
try {
  fs.mkdirSync(serverDirectory, { recursive: true });
  copy(installer, path.join(stage, installerName));
  // One-step setup for a new computer (installs, connects, starts).
  copy(path.join(repository, 'deploy', 'windows-desktop', 'Setup-TorWatch.ps1'), path.join(stage, 'Setup-TorWatch.ps1'));
  fs.writeFileSync(path.join(stage, 'Setup TorWatch.cmd'),
    '@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup-TorWatch.ps1" %*\r\npause\r\n');
  for (const name of ['Start-TorWatchServer.ps1', 'README.md']) {
    copy(path.join(repository, 'deploy', 'windows-desktop', name), path.join(serverDirectory, name));
  }
  for (const name of ['compose.yaml', 'Dockerfile', 'Caddyfile']) {
    copy(path.join(repository, 'deploy', 'torwatch-server', name), path.join(serverDirectory, name));
  }
  const tracked = spawnSync('git', ['ls-files', '-z', 'torrent-streamer'], { cwd: repository, encoding: 'utf8' });
  if (tracked.status !== 0) throw new Error('Could not enumerate tracked backend source.');
  let sourceFiles = 0;
  for (const source of tracked.stdout.split('\0').filter(Boolean)) {
    const relative = source.replaceAll('\\', '/').replace(/^torrent-streamer\//, '');
    if (!/\.(go|sql)$/.test(relative) && !['go.mod', 'go.sum'].includes(relative)) continue;
    const target = path.resolve(serverDirectory, 'backend', relative);
    if (!target.startsWith(path.join(serverDirectory, 'backend') + path.sep)) throw new Error('Invalid backend source path.');
    copy(path.join(repository, source), target);
    sourceFiles++;
  }
  if (!sourceFiles || !fs.existsSync(path.join(serverDirectory, 'backend', 'cmd', 'vod', 'main.go'))) throw new Error('Backend source is incomplete.');
  fs.writeFileSync(path.join(stage, 'START HERE.md'), `# TorWatch Windows ${version}

## Quickest: one step

Double-click **Setup TorWatch.cmd**. It installs ${installerName}, connects TorWatch to your server and starts it:

- **Your existing server** (default): enter the address your phone uses, for example \`http://homeserver.your-tailnet.ts.net:8080\`. Library, watch progress and Continue Watching are shared with your other devices. Nothing else is installed; if the server is only reachable over Tailscale, it offers to install Tailscale and waits while you sign in.
- **A new server on this computer**: run \`Setup-TorWatch.ps1 -Local\` from PowerShell. It installs Docker Desktop if needed, starts it and sets up the server in LocalServer (it asks for your TMDb key). That server keeps its own library and watch progress.

Run it again any time to update the app or change the server. Options: \`-Server <address>\`, \`-Local\`, \`-LocalPort <port>\`, \`-NoLaunch\`.

## By hand

Install ${installerName}. If a TorWatch server already runs on another computer, choose Connect to an existing server and enter the address your other devices use. No Docker is needed on this computer, and every device on that server shares its library and watch progress.

To set up a new server on this computer, follow LocalServer/README.md and run LocalServer/Start-TorWatchServer.ps1. The complete backend source and Docker build files are included. Its database is separate from any other server.

This bundle contains no personal server URL, provider keys, saved settings, runtime data or database. The local starter creates the recipient's own configuration on first run.
`);
  const hashes = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else hashes.push(`${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}  ${path.relative(stage, file).replaceAll('\\', '/')}`);
    }
  };
  walk(stage);
  fs.writeFileSync(path.join(stage, 'SHA256SUMS.txt'), hashes.join('\n') + '\n');
  const archive = spawnSync('tar', ['-a', '-cf', temporaryZip, '-C', stage, '.'], { stdio: 'inherit', windowsHide: true });
  if (archive.status !== 0) throw new Error('Windows bundle compression failed.');
  fs.renameSync(temporaryZip, finalZip);
  console.log(`Built ${finalZip} (${sourceFiles} backend source files; no runtime configuration copied).`);
} finally {
  if (path.dirname(stage) !== output) throw new Error('Bundle cleanup path escaped release.');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.rmSync(temporaryZip, { force: true });
}
