// Runtime catalog flag (plan P5): catalogSource=renderer|bff.
// "renderer" keeps the characterized V1 provider calls active; "bff" routes
// catalog discovery through the backend /v2/catalog/* contract.
// Browser/native mobile always use the server catalog; provider credentials
// belong on the server. Electron resolution priority: localStorage override, then
// the main-process config (CATALOG_SOURCE, seeded from
// TORWATCH_CATALOG_SOURCE), then the build-time env, then "renderer".
// The config module is loaded lazily so pure flag logic stays testable
// outside the renderer (node --test).

export type CatalogSource = 'renderer' | 'bff';

const CATALOG_SOURCE_OVERRIDE_KEY = 'mw_catalog_source';

export function normalizeCatalogSource(value: unknown): CatalogSource {
  return String(value ?? '').trim().toLowerCase() === 'bff' ? 'bff' : 'renderer';
}

export function resolveCatalogSource(inputs: {
  localOverride?: string | null;
  configValue?: string | null;
  envValue?: string | null;
}): CatalogSource {
  if (inputs.localOverride !== undefined && inputs.localOverride !== null && String(inputs.localOverride).trim() !== '') {
    return normalizeCatalogSource(inputs.localOverride);
  }
  if (inputs.configValue !== undefined && inputs.configValue !== null && String(inputs.configValue).trim() !== '') {
    return normalizeCatalogSource(inputs.configValue);
  }
  if (inputs.envValue !== undefined && inputs.envValue !== null && String(inputs.envValue).trim() !== '') {
    return normalizeCatalogSource(inputs.envValue);
  }
  return 'renderer';
}

function localOverride(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(CATALOG_SOURCE_OVERRIDE_KEY);
  } catch {
    return null;
  }
}

export async function getCatalogSource(): Promise<CatalogSource> {
  // Mobile exposes only an openSetup shim, not Electron's secure settings.
  // Do not import desktop config or honor stale renderer overrides there:
  // doing so asks an iPhone for credentials it should never need to hold.
  if (typeof window !== 'undefined' && typeof window.electronAPI?.getConfig !== 'function') {
    return 'bff';
  }

  let configValue: string | null = null;
  try {
    const { getAllConfig } = await import('./config');
    const config = await getAllConfig();
    configValue = config?.CATALOG_SOURCE ?? null;
  } catch {
    configValue = null;
  }
  const envValue = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_CATALOG_SOURCE ?? null;
  return resolveCatalogSource({ localOverride: localOverride(), configValue, envValue });
}

// Instant rollback path (plan P5 migration map): flip the override back to
// "renderer" without touching the main-process config.
export function setCatalogSourceOverride(value: CatalogSource | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (value === null) {
      window.localStorage.removeItem(CATALOG_SOURCE_OVERRIDE_KEY);
    } else {
      window.localStorage.setItem(CATALOG_SOURCE_OVERRIDE_KEY, normalizeCatalogSource(value));
    }
  } catch (error) {
    console.warn('[CatalogSource] Could not persist the catalog source override.', error);
  }
}
