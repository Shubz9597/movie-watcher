import { app, safeStorage } from "electron";
import { spawn, execFile } from "child_process";
import crypto from "crypto";
import fs from "fs";
import net from "net";
import path from "path";
import { promisify } from "util";
import { rotateLogFile } from "../diagnostics/diagnostic-logger.js";

const execFileAsync = promisify(execFile);
const DEFAULT_POSTGRES_PORT = 54329;
const DEFAULT_PROWLARR_PORT = 9696;
const DEFAULT_FLARESOLVERR_PORT = 8191;
const DEFAULT_GLUETUN_HTTP_PROXY_PORT = 8888;
const INFRASTRUCTURE_READY_CACHE_MS = 30_000;
const COMPOSE_ENV_KEYS = [
  "MW_ENV",
  "MW_DATA_DIR",
  "MW_BIND_HOST",
  "MW_CONTAINER_PREFIX",
  "MW_POSTGRES_PORT",
  "MW_PROWLARR_PORT",
  "MW_FLARESOLVERR_PORT",
  "MW_GLUETUN_HTTP_PROXY_PORT",
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "POSTGRES_DB",
  "PUID",
  "PGID",
  "VPN_SERVICE_PROVIDER",
  "VPN_TYPE",
  "WIREGUARD_PRIVATE_KEY",
  "WIREGUARD_ADDRESSES",
  "SERVER_CITIES",
  "TZ",
];
const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "PROXY_URL"];
const BACKEND_URL = "http://127.0.0.1:4001";
const DEFAULT_PROWLARR_INDEXERS = [
  { definition: "yts", name: "YTS", priority: 10, minimumSeeders: 3 },
  {
    definition: "nyaasi",
    name: "Nyaa.si",
    priority: 10,
    minimumSeeders: 1,
    fields: {
      prefer_magnet_links: true,
      sonarr_compatibility: true,
      strip_s01: true,
      radarr_compatibility: false,
      "filter-id": 2,
      "cat-id": 0,
      sort: 0,
      type: 1,
    },
  },
  { implementation: "SubsPlease", name: "SubsPlease", priority: 10, minimumSeeders: 1 },
  { implementation: "Knaben", name: "Knaben", priority: 20, minimumSeeders: 2 },
  { definition: "torrentdownload", name: "TorrentDownload", priority: 20, minimumSeeders: 2 },
  { definition: "thepiratebay", name: "The Pirate Bay", priority: 25, minimumSeeders: 2 },
  {
    definition: "limetorrents",
    name: "LimeTorrents",
    priority: 25,
    minimumSeeders: 2,
    preferMagnet: false,
  },
];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readLogTail(filePath, maxBytes = 12_000) {
  try {
    const data = fs.readFileSync(filePath);
    return data.subarray(Math.max(0, data.length - maxBytes)).toString("utf8");
  } catch {
    return "";
  }
}

function normalizeDockerPath(value) {
  return path.resolve(value).replaceAll("\\", "/");
}

function randomPassword() {
  return crypto.randomBytes(24).toString("base64url");
}

function commandError(message, code, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function envFileLine(key, value) {
  const text = String(value ?? "");
  if (/^[A-Za-z0-9_./:@+-]*$/.test(text)) return `${key}=${text}`;
  return `${key}=${JSON.stringify(text)}`;
}

function usesLegacyRuntimeIdentity(stored) {
  if (stored.setupComplete !== true || stored.postgresUser !== "moviewatcher") return false;

  const databaseName = stored.databaseName || "torwatch";
  const composeProjectName = stored.composeProjectName || "torwatch";
  return databaseName === "torwatch" && composeProjectName === "torwatch";
}

function composeStartMessage(cause) {
  const output = [cause?.stderr, cause?.stdout, cause?.message]
    .filter(Boolean)
    .join("\n");

  if (/port is already allocated|address already in use/i.test(output)) {
    const port = output.match(/(?:127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d+)/)?.[1];
    return port
      ? `TorWatch cannot start because port ${port} is already in use.`
      : "TorWatch cannot start because one of its ports is already in use.";
  }
  if (/cannot connect to the docker daemon|docker engine is stopped|dockerdesktoplinuxengine/i.test(output)) {
    return "Docker Desktop is installed, but its engine is not running.";
  }
  if (/pull access denied|failed to resolve source metadata|failed to do request|i\/o timeout/i.test(output)) {
    return "TorWatch could not download a required service. Check your internet connection and try again.";
  }
  return "TorWatch services could not start. Open Settings and try again.";
}

export class RuntimeManager {
  constructor({ reportError } = {}) {
    this.runtimeDir = path.join(app.getPath("userData"), "runtime");
    this.settingsPath = path.join(this.runtimeDir, "settings.json");
    this.secretsPath = path.join(this.runtimeDir, "secrets.bin");
    this.logDir = path.join(app.getPath("userData"), "logs");
    this.backendProcess = null;
    this.dockerReadyPromise = null;
    this.infrastructureStartPromise = null;
    this.infrastructureReady = null;
    this.tmdbProxyStartPromise = null;
    this.stopping = false;
    this.reportError = reportError;
  }

  get composePath() {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, "infrastructure", "compose.yaml");
    }
    return path.resolve(app.getAppPath(), "..", "docker-compose.yml");
  }

  get backendPath() {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, "backend", process.platform === "win32" ? "torWatcher.exe" : "vod");
    }
    return path.resolve(app.getAppPath(), "..", "torrent-streamer", "bin", process.platform === "win32" ? "torWatcher.exe" : "vod");
  }

  defaultConfiguration() {
    return {
      setupComplete: false,
      dataDir: path.join(app.getPath("videos"), "TorWatch"),
      vpnProvider: "mullvad",
      vpnType: "wireguard",
      vpnAddresses: "",
      serverCities: "",
      postgresUser: "torwatch",
      databaseName: "torwatch",
      composeProjectName: "torwatch",
      postgresPort: DEFAULT_POSTGRES_PORT,
      prowlarrPort: DEFAULT_PROWLARR_PORT,
    };
  }

  loadSettings() {
    try {
      const stored = JSON.parse(fs.readFileSync(this.settingsPath, "utf8"));
      const isLegacyInstallation = stored.setupComplete === true && !stored.databaseName;
      const hasMixedLegacyIdentity = usesLegacyRuntimeIdentity(stored);
      return {
        ...this.defaultConfiguration(),
        ...stored,
        databaseName: hasMixedLegacyIdentity
          ? "moviewatcher"
          : stored.databaseName || (isLegacyInstallation ? "moviewatcher" : "torwatch"),
        composeProjectName: hasMixedLegacyIdentity
          ? "movie-watcher"
          : stored.composeProjectName || (isLegacyInstallation ? "movie-watcher" : "torwatch"),
      };
    } catch {
      return this.defaultConfiguration();
    }
  }

  loadSecrets() {
    try {
      const stored = fs.readFileSync(this.secretsPath);
      const plaintext = safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(stored)
        : stored.toString("utf8");
      return JSON.parse(plaintext);
    } catch {
      return {};
    }
  }

  writeSecrets(secrets) {
    fs.mkdirSync(this.runtimeDir, { recursive: true });
    const encoded = JSON.stringify(secrets);
    fs.writeFileSync(
      this.secretsPath,
      safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(encoded) : Buffer.from(encoded, "utf8"),
    );
  }

  saveOpenSubtitlesAPIKey(apiKey) {
    const credential = String(apiKey || "").trim();
    if (!credential) throw commandError("Enter an OpenSubtitles API key.", "INVALID_CONFIGURATION");
    const secrets = this.loadSecrets();
    secrets.openSubApiKey = credential;
    this.writeSecrets(secrets);
  }

  saveCatalogSecrets(config) {
    const secrets = this.loadSecrets();
    const accessToken = String(config.TMDB_ACCESS_TOKEN || "").trim();
    const apiKey = String(config.TMDB_API_KEY || "").trim();
    if (accessToken) {
      secrets.tmdbAccessToken = accessToken;
      delete secrets.tmdbApiKey;
    } else if (apiKey) {
      secrets.tmdbApiKey = apiKey;
      delete secrets.tmdbAccessToken;
    }
    this.writeSecrets(secrets);
  }

  loadCatalogSecrets() {
    const secrets = this.loadSecrets();
    return {
      ...(secrets.tmdbApiKey ? { TMDB_API_KEY: secrets.tmdbApiKey } : {}),
      ...(secrets.tmdbAccessToken ? { TMDB_ACCESS_TOKEN: secrets.tmdbAccessToken } : {}),
    };
  }

  snapshotConfiguration() {
    return {
      settings: this.loadSettings(),
      secrets: this.loadSecrets(),
    };
  }

  restoreConfiguration(snapshot) {
    if (!snapshot?.settings || !snapshot?.secrets) return;
    fs.mkdirSync(this.runtimeDir, { recursive: true });
    fs.writeFileSync(this.settingsPath, JSON.stringify(snapshot.settings, null, 2), "utf8");
    this.writeSecrets(snapshot.secrets);
  }

  saveConfiguration(input, options = {}) {
    const requestedDataDir = String(input.dataDir || "").trim();
    if (!requestedDataDir) throw commandError("Choose a storage folder.", "INVALID_CONFIGURATION");
    const dataDir = path.resolve(requestedDataDir);
    const previousSettings = this.loadSettings();
    const previousSecrets = this.loadSecrets();
    const vpnPrivateKey = input.clearVpnConfiguration
      ? ""
      : String(input.vpnPrivateKey || "").trim() || previousSecrets.vpnPrivateKey;
    const openSubApiKey = String(input.openSubApiKey || "").trim()
      || previousSecrets.openSubApiKey
      || process.env.OPENSUB_API_KEY
      || process.env.OPENSUBTITLES_API_KEY;
    const openSubUserToken = input.clearOpenSubUserToken
      ? ""
      : String(input.openSubUserToken || "").trim()
        || previousSecrets.openSubUserToken
        || process.env.OPENSUBTITLES_USER_TOKEN
        || process.env.OPENSUB_USER_TOKEN;
    const vpnAddresses = input.clearVpnConfiguration ? "" : String(input.vpnAddresses || "").trim();
    if (Boolean(vpnPrivateKey) !== Boolean(vpnAddresses)) {
      throw commandError("Add both the WireGuard private key and address, or leave both blank to use the normal/system-VPN route.", "INVALID_CONFIGURATION");
    }

    const settings = {
      setupComplete: options.setupComplete ?? true,
      dataDir,
      vpnProvider: String(input.vpnProvider || "mullvad").trim(),
      vpnType: String(input.vpnType || "wireguard").trim(),
      vpnAddresses,
      serverCities: String(input.serverCities || "").trim(),
      postgresUser: previousSettings.postgresUser || "torwatch",
      databaseName: previousSettings.databaseName || "torwatch",
      composeProjectName: previousSettings.composeProjectName || "torwatch",
      postgresPort: Number(input.postgresPort) || DEFAULT_POSTGRES_PORT,
      prowlarrPort: Number(input.prowlarrPort) || DEFAULT_PROWLARR_PORT,
    };
    const secrets = {
      ...previousSecrets,
      vpnPrivateKey,
      openSubApiKey,
      postgresPassword: previousSecrets.postgresPassword || randomPassword(),
    };
    if (openSubUserToken) secrets.openSubUserToken = openSubUserToken;
    else delete secrets.openSubUserToken;
    const tmdbKey = String(input.tmdbKey || "").trim().replace(/^Bearer\s+/i, "").trim();
    if (tmdbKey && !/^[a-f0-9]{32}$/i.test(tmdbKey)) {
      secrets.tmdbAccessToken = tmdbKey;
      delete secrets.tmdbApiKey;
    } else if (tmdbKey) {
      secrets.tmdbApiKey = tmdbKey;
      delete secrets.tmdbAccessToken;
    }

    fs.mkdirSync(this.runtimeDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(dataDir, "subtitles"), { recursive: true });
    fs.writeFileSync(this.settingsPath, JSON.stringify(settings, null, 2), "utf8");
    this.writeSecrets(secrets);
    this.infrastructureReady = null;
    return settings;
  }

  markSetupComplete() {
    const settings = this.loadSettings();
    settings.setupComplete = true;
    fs.mkdirSync(this.runtimeDir, { recursive: true });
    fs.writeFileSync(this.settingsPath, JSON.stringify(settings, null, 2), "utf8");
  }

  isConfigured() {
    return this.loadSettings().setupComplete === true;
  }

  isRuntimeConfigured() {
    const settings = this.loadSettings();
    const secrets = this.loadSecrets();
    return settings.setupComplete === true && Boolean(secrets.postgresPassword);
  }

  hasEmbeddedVpnConfiguration(settings = this.loadSettings(), secrets = this.loadSecrets()) {
    return Boolean(settings.vpnAddresses && secrets.vpnPrivateKey);
  }

  composeProfile(settings, secrets) {
    return this.hasEmbeddedVpnConfiguration(settings, secrets) ? "embedded-vpn" : null;
  }

  composeEnvironment(settings, secrets) {
    const runtimeEnvFile = path.join(this.runtimeDir, "compose.env");
    const proxyEnvFile = path.join(this.runtimeDir, "proxy.env");
    const env = {
      ...process.env,
      MW_ENV: "electron",
      MW_RUNTIME_ENV_FILE: normalizeDockerPath(runtimeEnvFile),
      MW_PROXY_ENV_FILE: normalizeDockerPath(proxyEnvFile),
      MW_DATA_DIR: normalizeDockerPath(settings.dataDir),
      MW_BIND_HOST: "127.0.0.1",
      MW_CONTAINER_PREFIX: settings.composeProjectName,
      MW_POSTGRES_PORT: String(settings.postgresPort),
      MW_PROWLARR_PORT: String(settings.prowlarrPort),
      MW_FLARESOLVERR_PORT: String(DEFAULT_FLARESOLVERR_PORT),
      MW_GLUETUN_HTTP_PROXY_PORT: String(DEFAULT_GLUETUN_HTTP_PROXY_PORT),
      POSTGRES_USER: settings.postgresUser,
      POSTGRES_PASSWORD: secrets.postgresPassword,
      POSTGRES_DB: settings.databaseName,
      PUID: "1000",
      PGID: "1000",
      VPN_SERVICE_PROVIDER: settings.vpnProvider,
      VPN_TYPE: settings.vpnType,
      WIREGUARD_PRIVATE_KEY: secrets.vpnPrivateKey,
      WIREGUARD_ADDRESSES: settings.vpnAddresses,
      SERVER_CITIES: settings.serverCities,
      TZ: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    };
    if (this.hasEmbeddedVpnConfiguration(settings, secrets)) {
      env.HTTP_PROXY = "http://gluetun:8888";
      env.HTTPS_PROXY = "http://gluetun:8888";
      env.NO_PROXY = "127.0.0.1,localhost,gluetun,flaresolverr,postgres";
      env.PROXY_URL = "http://gluetun:8888";
    } else {
      delete env.HTTP_PROXY;
      delete env.HTTPS_PROXY;
      delete env.NO_PROXY;
      delete env.PROXY_URL;
    }
    return env;
  }

  writeComposeEnvironment(env) {
    fs.mkdirSync(this.runtimeDir, { recursive: true });
    const body = COMPOSE_ENV_KEYS
      .filter((key) => env[key] !== undefined)
      .map((key) => envFileLine(key, env[key]))
      .join("\n");
    fs.writeFileSync(path.join(this.runtimeDir, "compose.env"), `${body}\n`, "utf8");
    const proxyBody = PROXY_ENV_KEYS
      .filter((key) => env[key] !== undefined)
      .map((key) => envFileLine(key, env[key]))
      .join("\n");
    fs.writeFileSync(path.join(this.runtimeDir, "proxy.env"), proxyBody ? `${proxyBody}\n` : "", "utf8");
  }

  removeComposeEnvironment() {
    for (const filename of ["compose.env", "proxy.env"]) {
      try {
        fs.rmSync(path.join(this.runtimeDir, filename), { force: true });
      } catch {
        // Best-effort cleanup for transient Docker Compose env files.
      }
    }
  }

  async docker(args, env, options = {}) {
    try {
      return await execFileAsync("docker", args, {
        env,
        windowsHide: true,
        timeout: options.timeout ?? 120_000,
        maxBuffer: 2 * 1024 * 1024,
      });
    } catch (cause) {
      const message = typeof options.message === "function"
        ? options.message(cause)
        : options.message || `Docker command failed: docker ${args.join(" ")}`;
      throw commandError(message, options.code || "DOCKER_COMMAND_FAILED", cause);
    }
  }

  async ensureDocker(onStatus = () => {}) {
    if (this.dockerReadyPromise) return this.dockerReadyPromise;

    this.dockerReadyPromise = this.ensureDockerOnce(onStatus);
    try {
      return await this.dockerReadyPromise;
    } finally {
      this.dockerReadyPromise = null;
    }
  }

  async ensureDockerOnce(onStatus = () => {}) {
    try {
      await execFileAsync("docker", ["--version"], { windowsHide: true, timeout: 10_000 });
    } catch (cause) {
      throw commandError("Docker Desktop is not installed. Install it, restart Windows if requested, and open TorWatch again.", "DOCKER_NOT_INSTALLED", cause);
    }

    try {
      await execFileAsync("docker", ["info", "--format", "{{.ServerVersion}}"], { windowsHide: true, timeout: 15_000 });
      return;
    } catch {
      if (process.platform !== "win32") {
        throw commandError("Docker is installed, but its engine is not running.", "DOCKER_NOT_RUNNING");
      }
    }

    const dockerDesktop = path.join(process.env.ProgramFiles || "C:\\Program Files", "Docker", "Docker", "Docker Desktop.exe");
    if (!fs.existsSync(dockerDesktop)) {
      throw commandError("Docker is installed, but its engine is not running.", "DOCKER_NOT_RUNNING");
    }

    onStatus("Starting Docker Desktop…");
    const desktop = spawn(dockerDesktop, [], { detached: true, stdio: "ignore", windowsHide: true });
    desktop.unref();
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await delay(2_000);
      try {
        await execFileAsync("docker", ["info", "--format", "{{.ServerVersion}}"], { windowsHide: true, timeout: 10_000 });
        return;
      } catch {
        // Docker Desktop can take a while to initialize WSL and its engine.
      }
    }
    throw commandError("Docker Desktop did not become ready within two minutes.", "DOCKER_START_TIMEOUT");
  }

  async startInfrastructure(onStatus = () => {}, options = {}) {
    if (
      this.infrastructureReady
      && Date.now() - this.infrastructureReady.readyAt < INFRASTRUCTURE_READY_CACHE_MS
    ) {
      return this.infrastructureReady.result;
    }
    if (this.infrastructureStartPromise) return this.infrastructureStartPromise;

    this.infrastructureStartPromise = this.startInfrastructureOnce(onStatus, options);
    try {
      const result = await this.infrastructureStartPromise;
      this.infrastructureReady = { result, readyAt: Date.now() };
      return result;
    } catch (error) {
      this.infrastructureReady = null;
      throw error;
    } finally {
      this.infrastructureStartPromise = null;
    }
  }

  async startInfrastructureOnce(onStatus = () => {}, options = {}) {
    const settings = this.loadSettings();
    const secrets = this.loadSecrets();
    if ((!settings.setupComplete && !options.allowIncomplete) || !secrets.postgresPassword) {
      throw commandError("Open Settings and finish setting up TorWatch.", "SETUP_REQUIRED");
    }
    if (!fs.existsSync(this.composePath)) {
      throw commandError("Some TorWatch installation files are missing. Reinstall TorWatch and try again.", "MISSING_RESOURCE");
    }

    const env = this.composeEnvironment(settings, secrets);
    const profile = this.composeProfile(settings, secrets);
    const embeddedVpn = profile !== null;
    this.writeComposeEnvironment(env);
    try {
      await this.ensureDocker(onStatus);
      if (embeddedVpn) {
        onStatus("Starting the VPN connection…");
        await this.docker(
          [
            "compose",
            "--project-name",
            settings.composeProjectName,
            "-f",
            this.composePath,
            "--profile",
            "embedded-vpn",
            "up",
            "-d",
            "gluetun",
          ],
          env,
          { timeout: 180_000, code: "COMPOSE_START_FAILED", message: composeStartMessage },
        );
        onStatus("Waiting for the VPN connection…");
        await this.waitForComposeServiceHealth(
          settings,
          env,
          "gluetun",
          120_000,
          "VPN connection",
          "embedded-vpn",
        );
      } else {
        // Gluetun is an optional proxy. Stop an existing instance without
        // deleting it; Prowlarr and FlareSolverr keep their own networks.
        try {
          await this.docker(
            [
              "compose",
              "--project-name",
              settings.composeProjectName,
              "-f",
              this.composePath,
              "--profile",
              "embedded-vpn",
              "stop",
              "gluetun",
            ],
            env,
            { timeout: 30_000, message: "The optional VPN service could not be stopped." },
          );
        } catch (error) {
          console.warn("[Runtime] Could not stop the optional VPN container:", error.message);
        }
      }
      onStatus("Starting all TorWatch services…");
      const composeArgs = [
        "compose",
        "--project-name",
        settings.composeProjectName,
        "-f",
        this.composePath,
      ];
      if (profile) composeArgs.push("--profile", profile);
      await this.docker(
        [
          ...composeArgs,
          "up",
          "-d",
          "--remove-orphans",
        ],
        env,
        { timeout: 180_000, code: "COMPOSE_START_FAILED", message: composeStartMessage },
      );

      if (!embeddedVpn) {
        // Profiles normally exclude Gluetun completely. Create its container
        // explicitly so all four TorWatch services remain visible, while
        // leaving it stopped until VPN credentials are supplied.
        try {
          await this.docker(
            [
              "compose",
              "--project-name",
              settings.composeProjectName,
              "-f",
              this.composePath,
              "--profile",
              "embedded-vpn",
              "create",
              "gluetun",
            ],
            env,
            { timeout: 180_000, message: "The optional VPN container could not be prepared." },
          );
        } catch (error) {
          // Gluetun is optional in this mode; a pull/create failure must not
          // prevent the normal or system-VPN route from starting.
          console.warn("[Runtime] Could not prepare the optional VPN container:", error.message);
        }
      }

      onStatus("Waiting for the database…");
      await this.waitForComposeServiceHealth(settings, env, "postgres", 90_000, "PostgreSQL", profile);
      onStatus("Waiting for search services…");
      await this.waitForPort("127.0.0.1", settings.prowlarrPort, 120_000, "Prowlarr");
      if (embeddedVpn) {
        await this.waitForPort("127.0.0.1", DEFAULT_GLUETUN_HTTP_PROXY_PORT, 30_000, "VPN proxy");
      }
    } finally {
      this.removeComposeEnvironment();
    }
    return { settings, secrets, env, embeddedVpn };
  }

  async ensureTmdbProxy(onStatus = () => {}) {
    if (this.tmdbProxyStartPromise) return this.tmdbProxyStartPromise;

    this.tmdbProxyStartPromise = this.ensureTmdbProxyOnce(onStatus);
    try {
      return await this.tmdbProxyStartPromise;
    } finally {
      this.tmdbProxyStartPromise = null;
    }
  }

  async ensureTmdbProxyOnce(onStatus = () => {}) {
    if (!this.hasEmbeddedVpnConfiguration()) {
      throw commandError("The VPN connection is not configured.", "VPN_NOT_CONFIGURED");
    }
    // TMDb fallback and playback must share one cold-start path. Starting only
    // Gluetun here left Postgres/Prowlarr stopped and immediately triggered a
    // second Compose run when playback startup continued.
    await this.startInfrastructure(onStatus);
    onStatus("Connecting TMDb through the VPN…");
    return `http://127.0.0.1:${DEFAULT_GLUETUN_HTTP_PROXY_PORT}`;
  }

  async waitForComposeServiceHealth(settings, env, service, timeoutMs, label, profile) {
    const started = Date.now();
    const composeArgs = [
      "compose",
      "--project-name",
      settings.composeProjectName,
      "-f",
      this.composePath,
    ];
    if (profile) composeArgs.push("--profile", profile);

    while (Date.now() - started < timeoutMs) {
      try {
        const { stdout: idOutput } = await execFileAsync(
          "docker",
          [...composeArgs, "ps", "-q", service],
          { env, windowsHide: true, timeout: 10_000 },
        );
        const containerId = idOutput.trim().split(/\s+/)[0];
        if (containerId) {
          const { stdout: healthOutput } = await execFileAsync(
            "docker",
            ["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", containerId],
            { env, windowsHide: true, timeout: 10_000 },
          );
          if (healthOutput.trim() === "healthy") return;
        }
      } catch {
        // Docker Desktop and container health can both be transient here.
      }
      await delay(1_000);
    }
    throw commandError(`${label} did not become healthy in time. Try again.`, "SERVICE_START_TIMEOUT");
  }

  waitForPort(host, port, timeoutMs, label) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const tryConnect = () => {
        const socket = net.createConnection({ host, port });
        let finished = false;
        socket.setTimeout(2_000);
        socket.once("connect", () => {
          if (finished) return;
          finished = true;
          socket.destroy();
          resolve();
        });
        const retry = () => {
          if (finished) return;
          finished = true;
          socket.destroy();
          if (Date.now() - started >= timeoutMs) {
            reject(commandError("TorWatch took too long to start. Check Docker Desktop and try again.", "SERVICE_START_TIMEOUT"));
          } else {
            setTimeout(tryConnect, 1_000);
          }
        };
        socket.once("error", retry);
        socket.once("timeout", retry);
      };
      tryConnect();
    });
  }

  readProwlarrApiKey(dataDir) {
    const configPath = path.join(dataDir, "prowlarr", "config.xml");
    try {
      const xml = fs.readFileSync(configPath, "utf8");
      return xml.match(/<ApiKey>([^<]+)<\/ApiKey>/i)?.[1]?.trim() || "";
    } catch {
      return "";
    }
  }

  async waitForProwlarrApiKey(dataDir, timeoutMs = 60_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const key = this.readProwlarrApiKey(dataDir);
      if (key) return key;
      await delay(1_000);
    }
    throw commandError("TorWatch could not finish starting. Try again in a moment.", "PROWLARR_CONFIGURATION_TIMEOUT");
  }

  async waitForProwlarrReady(port, apiKey, timeoutMs = 90_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/v1/system/status`, {
          headers: { Accept: "application/json", "X-Api-Key": apiKey },
          signal: AbortSignal.timeout(3_000),
        });
        if (response.ok) return;
      } catch {
        // The port and saved API key can exist before Prowlarr's API is ready.
      }
      await delay(1_000);
    }
    throw commandError("Prowlarr did not become ready in time. Try again.", "PROWLARR_START_TIMEOUT");
  }

  async prowlarrRequest(port, apiKey, route, options = {}) {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/${route}`, {
      ...options,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Api-Key": apiKey,
        ...options.headers,
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw commandError(
        `Prowlarr returned HTTP ${response.status} while configuring search sources.`,
        "PROWLARR_REQUEST_FAILED",
      );
    }
    if (response.status === 204) return null;
    return response.json();
  }

  setProwlarrFields(fields, values) {
    for (const field of fields || []) {
      if (Object.hasOwn(values, field.name)) field.value = values[field.name];
    }
  }

  async bootstrapProwlarrIndexers(settings, apiKey, onStatus = () => {}) {
    try {
      const existing = await this.prowlarrRequest(settings.prowlarrPort, apiKey, "indexer");
      if (Array.isArray(existing) && existing.length > 0) {
        return { added: 0, preserved: existing.length, failed: [] };
      }

      const schemas = await this.prowlarrRequest(settings.prowlarrPort, apiKey, "indexer/schema");
      const appProfiles = await this.prowlarrRequest(settings.prowlarrPort, apiKey, "appProfile");
      const appProfileId = appProfiles.find((profile) => Number(profile.id) > 0)?.id;
      if (!appProfileId) {
        throw commandError("Prowlarr has no usable application profile.", "PROWLARR_PROFILE_MISSING");
      }
      const added = [];
      const failed = [];
      onStatus("Adding starter search sources…");

      for (const starter of DEFAULT_PROWLARR_INDEXERS) {
        const schema = schemas.find((candidate) => {
          if (starter.implementation) return candidate.implementation === starter.implementation;
          return candidate.fields?.some(
            (field) => field.name === "definitionFile" && field.value === starter.definition,
          );
        });
        if (!schema) {
          failed.push(starter.name);
          continue;
        }

        const payload = structuredClone(schema);
        delete payload.id;
        payload.name = starter.name;
        payload.enable = true;
        payload.priority = starter.priority;
        payload.appProfileId = appProfileId;
        payload.tags = [];
        this.setProwlarrFields(payload.fields, {
          "baseSettings.grabLimit": 15,
          "torrentBaseSettings.appMinimumSeeders": starter.minimumSeeders,
          "torrentBaseSettings.preferMagnetUrl": starter.preferMagnet ?? true,
          ...starter.fields,
        });

        try {
          await this.prowlarrRequest(settings.prowlarrPort, apiKey, "indexer", {
            method: "POST",
            body: JSON.stringify(payload),
          });
          added.push(starter.name);
        } catch (error) {
          failed.push(starter.name);
          console.warn(`[Prowlarr] Could not add starter source ${starter.name}:`, error.message);
        }
      }

      if (added.length > 0) onStatus(`Added ${added.length} starter search sources.`);
      return { added: added.length, preserved: 0, failed };
    } catch (error) {
      console.warn("[Prowlarr] Starter sources were not configured:", error.message);
      return { added: 0, preserved: 0, failed: DEFAULT_PROWLARR_INDEXERS.map(({ name }) => name) };
    }
  }

  async backendIsReady() {
    try {
      const response = await fetch(`${BACKEND_URL}/healthz`, { signal: AbortSignal.timeout(1_500) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async startBackend(onStatus = () => {}, options = {}) {
    this.stopping = false;
    const { settings, secrets } = await this.startInfrastructure(onStatus, options);
    // The backend can outlive a crashed/older Electron process while its
    // Docker dependencies were explicitly stopped. Always restore Compose
    // before treating an existing health endpoint as sufficient.
    if (await this.backendIsReady()) return;
    const prowlarrApiKey = await this.waitForProwlarrApiKey(settings.dataDir);
    await this.waitForProwlarrReady(settings.prowlarrPort, prowlarrApiKey);
    await this.bootstrapProwlarrIndexers(settings, prowlarrApiKey, onStatus);
    if (!fs.existsSync(this.backendPath)) {
      throw commandError("Some TorWatch installation files are missing. Reinstall TorWatch and try again.", "MISSING_RESOURCE");
    }

    fs.mkdirSync(this.logDir, { recursive: true });
    const backendLogPath = path.join(this.logDir, "backend.log");
    const errorLogPath = path.join(this.logDir, "errors.log");
    rotateLogFile(backendLogPath);
    rotateLogFile(errorLogPath);
    const backendStderr = fs.openSync(backendLogPath, "a");
    const backendEnv = {
      ...process.env,
      PG_DSN: `postgres://${encodeURIComponent(settings.postgresUser)}:${encodeURIComponent(secrets.postgresPassword)}@127.0.0.1:${settings.postgresPort}/${encodeURIComponent(settings.databaseName)}?sslmode=disable`,
      PROWLARR_URL: `http://127.0.0.1:${settings.prowlarrPort}`,
      PROWLARR_API_KEY: prowlarrApiKey,
      TORRENT_DATA_ROOT: path.join(settings.dataDir, "downloads"),
      SUB_CACHE_DIR: path.join(settings.dataDir, "subtitles"),
      LOG_FILE: backendLogPath,
      ERROR_LOG_FILE: errorLogPath,
      LOG_CONSOLE: "false",
      TORWATCH_APP_VERSION: app.getVersion(),
      LISTEN: "127.0.0.1:4001",
    };
    const openSubApiKey = secrets.openSubApiKey || process.env.OPENSUB_API_KEY || process.env.OPENSUBTITLES_API_KEY;
    const openSubUserToken = secrets.openSubUserToken || process.env.OPENSUBTITLES_USER_TOKEN || process.env.OPENSUB_USER_TOKEN;
    if (openSubApiKey) backendEnv.OPENSUB_API_KEY = openSubApiKey;
    if (openSubUserToken) backendEnv.OPENSUBTITLES_USER_TOKEN = openSubUserToken;

    onStatus("Finishing setup…");
    try {
      this.backendProcess = spawn(this.backendPath, [], {
        cwd: this.runtimeDir,
        env: backendEnv,
        windowsHide: true,
        stdio: ["ignore", backendStderr, backendStderr],
      });
    } finally {
      fs.closeSync(backendStderr);
    }
    const backendProcess = this.backendProcess;
    backendProcess.once("error", (error) => {
      this.reportBackendError("backend process error", backendLogPath, { error });
    });
    backendProcess.once("exit", (code, signal) => {
      const expected = this.stopping;
      this.backendProcess = null;
      if (!expected) {
        this.reportBackendError("backend exited unexpectedly", backendLogPath, { code, signal });
      }
    });

    const started = Date.now();
    while (Date.now() - started < 45_000) {
      if (await this.backendIsReady()) return;
      if (!this.backendProcess) {
        throw commandError("TorWatch stopped while starting. Open Settings and check your connections.", "BACKEND_EXITED");
      }
      await delay(500);
    }
    throw commandError("TorWatch took too long to start. Open Settings and check your connections.", "BACKEND_START_TIMEOUT");
  }

  async stopBackend() {
    this.stopping = true;
    const child = this.backendProcess;
    this.backendProcess = null;
    if (!child || child.exitCode !== null) return;
    if (!child.killed) child.kill();
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      delay(5_000),
    ]);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        delay(2_000),
      ]);
    }
  }

  reportBackendError(message, backendLogPath, details) {
    const context = {
      ...details,
      backend_log: backendLogPath,
      backend_log_tail: readLogTail(backendLogPath),
    };
    if (typeof this.reportError !== "function") {
      console.error(`[Runtime] ${message}:`, context);
      return;
    }
    const record = this.reportError("backend-process", message, context, { sourceLog: "backend.log" });
    if (!record?.correlation_id) return;
    try {
      fs.appendFileSync(
        backendLogPath,
        `${new Date().toISOString()} [runtime] ${message} correlation_id=${record.correlation_id}\n`,
        "utf8",
      );
    } catch {
      // The correlated errors.log record still contains the attempted backend path and tail.
    }
  }

  async stopInfrastructure() {
    this.infrastructureReady = null;
    const settings = this.loadSettings();
    const secrets = this.loadSecrets();
    if (!settings.setupComplete || !secrets.postgresPassword || !fs.existsSync(this.composePath)) return;

    // Never launch Docker Desktop during shutdown. If its engine is already
    // unavailable, there is nothing useful for TorWatch to stop.
    try {
      await execFileAsync("docker", ["info", "--format", "{{.ServerVersion}}"], {
        windowsHide: true,
        timeout: 5_000,
      });
    } catch {
      return;
    }

    try {
      const env = this.composeEnvironment(settings, secrets);
      const profile = this.composeProfile(settings, secrets);
      this.writeComposeEnvironment(env);
      const composeArgs = [
        "compose",
        "--project-name",
        settings.composeProjectName,
        "-f",
        this.composePath,
      ];
      if (profile) composeArgs.push("--profile", profile);
      composeArgs.push("stop", "--timeout", "15");
      await this.docker(
        composeArgs,
        env,
        {
          timeout: 30_000,
          code: "COMPOSE_STOP_FAILED",
          message: "TorWatch services could not be stopped cleanly.",
        },
      );
    } catch (error) {
      console.warn("[Runtime] Could not stop TorWatch containers:", error.message);
    } finally {
      this.removeComposeEnvironment();
    }
  }

  async shutdown() {
    await this.stopBackend();
    await this.stopInfrastructure();
  }
}
