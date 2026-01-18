// Secure configuration management for Electron
// Uses Electron's secure storage (main process)

let configCache: Record<string, string> | null = null;
let configLoadPromise: Promise<Record<string, string>> | null = null;

async function loadConfig(): Promise<Record<string, string>> {
  if (configCache) return configCache;
  
  // Prevent multiple simultaneous loads
  if (configLoadPromise) return configLoadPromise;
  
  configLoadPromise = (async () => {
    const config: Record<string, string> = {};
    
    // Get from Electron main process (secure storage)
    if (typeof window !== 'undefined' && (window as any).electronAPI?.getConfig) {
      try {
        const mainConfig = await (window as any).electronAPI.getConfig();
        if (mainConfig && typeof mainConfig === 'object') {
          Object.assign(config, mainConfig);
        }
      } catch (err) {
        console.warn('[Config] Failed to load from secure storage:', err);
      }
    }

    // Fallback to localStorage (less secure but works)
    const stored = localStorage.getItem('mw_config');
    if (stored) {
      try {
        const localConfig = JSON.parse(stored);
        if (localConfig && typeof localConfig === 'object') {
          Object.assign(config, localConfig);
        }
      } catch {
        // Ignore parse errors
      }
    }

    // Log missing keys for debugging
    if (!config.TMDB_API_KEY && !config.TMDB_ACCESS_TOKEN) {
      console.warn('[Config] TMDb API key or access token not found. Please configure in settings.');
    }
    if (!config.PROWLARR_URL || !config.PROWLARR_API_KEY) {
      console.warn('[Config] Prowlarr configuration not found. Please configure in settings.');
    }

    configCache = config;
    return config;
  })();
  
  const result = await configLoadPromise;
  configLoadPromise = null;
  return result;
}

async function saveConfig(config: Record<string, string>): Promise<void> {
  configCache = config;

  // Save to Electron main process (secure storage)
  if (typeof window !== 'undefined' && (window as any).electronAPI?.setConfig) {
    try {
      await (window as any).electronAPI.setConfig(config);
      return;
    } catch (err) {
      console.warn('[Config] Failed to save to secure storage:', err);
    }
  }

  // Fallback to localStorage
  localStorage.setItem('mw_config', JSON.stringify(config));
}

export async function getConfig(key: string): Promise<string | undefined> {
  const config = await loadConfig();
  return config[key];
}

export async function setConfig(key: string, value: string): Promise<void> {
  const config = await loadConfig();
  config[key] = value;
  await saveConfig(config);
}

export async function getAllConfig(): Promise<Record<string, string>> {
  return await loadConfig();
}



