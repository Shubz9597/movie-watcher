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
  fs.writeFileSync(path.join(stage, 'START HERE.md'), `# TorWatch Windows ${version}\n\nInstall ${installerName}.\n\nFor your existing homeserver, choose Homeserver (recommended) and use the same URL as your phone. No local Docker server is needed. To use the phone's existing Continue Watching records, enter its mw_device_id under Link Continue Watching from your phone in connection settings. The same URL shares the library database; progress is scoped to the viewing profile.\n\nFor an independent local installation, follow LocalServer/README.md and run LocalServer/Start-TorWatchServer.ps1. The complete backend source and Docker build files are included. Its database is separate from any other server.\n\nThis bundle contains no personal server URL, provider keys, saved settings, runtime data or database. The local starter creates the recipient's own configuration on first run.\n`);
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
