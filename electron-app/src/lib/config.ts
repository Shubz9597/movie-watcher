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
    let secureBridgeState: 'available' | 'unavailable' | 'failed' = 'unavailable';
    
    // Get from Electron main process (secure storage)
    if (typeof window !== 'undefined' && (window as any).electronAPI?.getConfig) {
      secureBridgeState = 'available';
      try {
        const mainConfig = await (window as any).electronAPI.getConfig();
        if (mainConfig && typeof mainConfig === 'object') {
          Object.assign(config, mainConfig);
        }
      } catch (err) {
        secureBridgeState = 'failed';
        console.error('[Config] Secure settings bridge failed while loading credentials:', err);
      }
    } else {
      console.error('[Config] Secure settings bridge is unavailable; packaged credentials cannot be loaded.');
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
      if (secureBridgeState === 'available') {
        console.warn('[Config] Secure settings loaded, but no TMDb credential is stored.');
      } else if (secureBridgeState === 'failed') {
        console.error('[Config] TMDb credential is unavailable because secure settings failed to load.');
      } else {
        console.error('[Config] TMDb credential is unavailable because the secure settings bridge is missing.');
      }
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



