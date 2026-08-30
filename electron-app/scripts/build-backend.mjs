import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import process from "process";
import { fileURLToPath } from "url";
import { rcedit } from "rcedit";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, "..");
const repositoryDir = path.resolve(projectDir, "..");
const backendDir = path.join(repositoryDir, "torrent-streamer");
const outputDir = path.join(backendDir, "bin");
const executable = path.join(outputDir, "torWatcher.exe");
const icon = path.join(projectDir, "build", "torwatch-icons", "icon.ico");
const packageJson = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8"));
const version = String(packageJson.version || "1.0.0");

fs.mkdirSync(outputDir, { recursive: true });

const build = spawnSync("go", [
  "build",
  "-trimpath",
  "-ldflags",
  "-s -w",
  "-o",
  executable,
  "./cmd/vod",
], {
  cwd: backendDir,
  env: process.env,
  stdio: "inherit",
});

if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status || 1);
if (!fs.existsSync(icon)) throw new Error(`Backend icon is missing: ${icon}`);

await rcedit(executable, {
  icon,
  "file-version": version,
  "product-version": version,
  "version-string": {
    CompanyName: "TorWatch",
    FileDescription: "TorWatch service",
    InternalName: "torWatcher",
    LegalCopyright: "Copyright © 2026 TorWatch",
    OriginalFilename: "torWatcher.exe",
    ProductName: "TorWatch",
  },
});

console.log(`Built torWatcher.exe ${version} with the TorWatch icon.`);
