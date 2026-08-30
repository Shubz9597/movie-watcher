import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import process from "process";
import { fileURLToPath } from "url";
import { rcedit } from "rcedit";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8"));
const version = String(packageJson.version || "1.0.0");
const builderCli = path.join(projectDir, "node_modules", "electron-builder", "out", "cli", "cli.js");
const outputDir = process.env.TORWATCH_PACKAGE_DIR
  ? path.resolve(projectDir, process.env.TORWATCH_PACKAGE_DIR)
  : path.join(projectDir, "release");
const stagingOutputDir = path.join(
  outputDir,
  `.electron-builder-${process.pid}-${Date.now()}`,
);
const unpackedDir = path.join(stagingOutputDir, "win-unpacked");
const executable = path.join(unpackedDir, "TorWatch.exe");
const icon = path.join(projectDir, "build", "torwatch-icons", "icon.ico");
const outputConfig = `-c.directories.output=${outputDir}`;
const stagingOutputConfig = `-c.directories.output=${stagingOutputDir}`;

function runBuilder(args) {
  const result = spawnSync(process.execPath, [builderCli, ...args], {
    cwd: projectDir,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`electron-builder failed with exit code ${result.status || 1}`);
  }
}

fs.mkdirSync(outputDir, { recursive: true });

try {
  // A packaged app can keep app.asar open on Windows. Building the unpacked app
  // in a unique directory prevents an older, running build from blocking a new
  // installer build.
  runBuilder(["--win", "--dir", stagingOutputConfig, "-c.win.signAndEditExecutable=false"]);

  await rcedit(executable, {
    icon,
    "file-version": version,
    "product-version": version,
    "version-string": {
      CompanyName: "TorWatch",
      FileDescription: "TorWatch desktop cinema",
      InternalName: "TorWatch",
      LegalCopyright: "Copyright © 2026 TorWatch",
      OriginalFilename: "TorWatch.exe",
      ProductName: "TorWatch",
    },
  });

  runBuilder([
    "--win",
    "nsis",
    "--prepackaged",
    unpackedDir,
    outputConfig,
    "-c.win.signAndEditExecutable=false",
  ]);
} finally {
  try {
    fs.rmSync(stagingOutputDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 250,
    });
  } catch (error) {
    console.warn(`Could not remove temporary packaging directory '${stagingOutputDir}':`, error);
  }
}
