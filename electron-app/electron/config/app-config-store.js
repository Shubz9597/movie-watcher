import fs from "fs";
import path from "path";

function removePrivateCatalogKeys(config) {
  const publicConfig = { ...config };
  delete publicConfig.TMDB_API_KEY;
  delete publicConfig.TMDB_ACCESS_TOKEN;
  return publicConfig;
}

function normalizeTmdbCredential(value) {
  return String(value || "").trim().replace(/^Bearer\s+/i, "").trim();
}

function parseTmdbCredential(value) {
  const credential = normalizeTmdbCredential(value);
  if (!credential) return { tmdbAccessToken: "", tmdbApiKey: "" };
  return /^[a-f0-9]{32}$/i.test(credential)
    ? { tmdbAccessToken: "", tmdbApiKey: credential }
    : { tmdbAccessToken: credential, tmdbApiKey: "" };
}

// Runtime catalog flag (plan P5): which catalog implementation the renderer
// uses. "renderer" keeps the characterized V1 provider calls active; "bff"
// routes catalog discovery through the backend /v2/catalog/* contract. Never
// a secret; surfaced through getPublicConfig.
export function normalizeCatalogSource(value) {
  return String(value || "").trim().toLowerCase() === "bff" ? "bff" : "renderer";
}

export function createAppConfigStore({ env = process.env, runtimeManager, userDataPath }) {
  const configPath = path.join(userDataPath, "config.json");
  let appConfig = {};

  try {
    if (fs.existsSync(configPath)) {
      const configData = fs.readFileSync(configPath, "utf-8");
      appConfig = JSON.parse(configData);
    }
  } catch (err) {
    console.warn("[Config] Failed to load config:", err);
  }

  if (!appConfig.TMDB_API_KEY && env.TMDB_API_KEY) {
    appConfig.TMDB_API_KEY = env.TMDB_API_KEY;
    console.log("[Config] Loaded TMDB_API_KEY from environment");
  }
  if (!appConfig.TMDB_ACCESS_TOKEN && env.TMDB_ACCESS_TOKEN) {
    appConfig.TMDB_ACCESS_TOKEN = env.TMDB_ACCESS_TOKEN;
    console.log("[Config] Loaded TMDB_ACCESS_TOKEN from environment");
  }

  // Catalog flag precedence: saved config value, then environment override,
  // then the safe default ("renderer" — V1 behavior unchanged).
  appConfig.CATALOG_SOURCE = normalizeCatalogSource(
    appConfig.CATALOG_SOURCE || env.TORWATCH_CATALOG_SOURCE || "renderer",
  );

  function getConfig() {
    return appConfig;
  }

  function hasTmdbCredential() {
    return Boolean(appConfig.TMDB_API_KEY || appConfig.TMDB_ACCESS_TOKEN);
  }

  function getPublicConfig() {
    return {
      ...removePrivateCatalogKeys(appConfig),
      hasTmdbKey: hasTmdbCredential(),
    };
  }

  function persist() {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(removePrivateCatalogKeys(appConfig), null, 2), "utf-8");
  }

  function saveConfig(config) {
    const normalized = { ...config };
    if ("CATALOG_SOURCE" in normalized) {
      normalized.CATALOG_SOURCE = normalizeCatalogSource(normalized.CATALOG_SOURCE);
    }
    appConfig = { ...appConfig, ...normalized };
    runtimeManager.saveCatalogSecrets(config);
    persist();
  }

  function hydrateSecureConfig() {
    const secureConfig = runtimeManager.loadCatalogSecrets();
    const hasSecureTmdb = Boolean(secureConfig.TMDB_API_KEY || secureConfig.TMDB_ACCESS_TOKEN);
    if (hasSecureTmdb) {
      appConfig = { ...appConfig, ...secureConfig };
    } else if (appConfig.TMDB_API_KEY || appConfig.TMDB_ACCESS_TOKEN) {
      runtimeManager.saveCatalogSecrets(appConfig);
    }
    const normalized = parseTmdbCredential(appConfig.TMDB_ACCESS_TOKEN || appConfig.TMDB_API_KEY);
    if (normalized.tmdbAccessToken) {
      appConfig.TMDB_ACCESS_TOKEN = normalized.tmdbAccessToken;
      delete appConfig.TMDB_API_KEY;
      runtimeManager.saveCatalogSecrets(appConfig);
    } else if (normalized.tmdbApiKey) {
      appConfig.TMDB_API_KEY = normalized.tmdbApiKey;
      delete appConfig.TMDB_ACCESS_TOKEN;
      runtimeManager.saveCatalogSecrets(appConfig);
    }
    persist();
    console.log("[Config] Configuration status:", {
      hasTmdbKey: hasTmdbCredential(),
    });
  }

  function resolveSetupCredentials(configuration = {}) {
    const secrets = runtimeManager.loadSecrets();
    const enteredTmdb = normalizeTmdbCredential(configuration.tmdbKey);
    const storedCredential = parseTmdbCredential(
      enteredTmdb || appConfig.TMDB_ACCESS_TOKEN || appConfig.TMDB_API_KEY,
    );

    return {
      ...storedCredential,
      openSubApiKey: String(configuration.openSubApiKey || "").trim()
        || secrets.openSubApiKey
        || env.OPENSUB_API_KEY
        || env.OPENSUBTITLES_API_KEY
        || "",
      openSubUserToken: configuration.clearOpenSubUserToken
        ? ""
        : String(configuration.openSubUserToken || "").trim()
          || secrets.openSubUserToken
          || env.OPENSUBTITLES_USER_TOKEN
          || env.OPENSUB_USER_TOKEN
          || "",
    };
  }

  function applyTmdbCredential(tmdbKey) {
    const credential = parseTmdbCredential(tmdbKey);
    if (credential.tmdbAccessToken) {
      appConfig.TMDB_ACCESS_TOKEN = credential.tmdbAccessToken;
      delete appConfig.TMDB_API_KEY;
    } else if (credential.tmdbApiKey) {
      appConfig.TMDB_API_KEY = credential.tmdbApiKey;
      delete appConfig.TMDB_ACCESS_TOKEN;
    }
  }

  return {
    applyTmdbCredential,
    getConfig,
    getPublicConfig,
    hasTmdbCredential,
    hydrateSecureConfig,
    persist,
    resolveSetupCredentials,
    saveConfig,
  };
}
