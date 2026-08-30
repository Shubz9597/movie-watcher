import type { CheckResult, SetupApi, SetupDefaults, SetupFormValues, SetupModeState, SetupResult } from './types';

declare global {
  interface Window {
    setupAPI?: SetupApi;
  }
}

const previewDefaults: SetupDefaults = {
  dataDir: 'C:\\TorWatch',
  setupComplete: false,
  vpnProvider: 'mullvad',
  vpnType: 'wireguard',
  vpnAddresses: '',
  serverCities: '',
  hasTmdbKey: false,
  hasOpenSubApiKey: false,
  hasOpenSubUserToken: false,
  hasVpnPrivateKey: false,
};

function resolvedPreviewMode(): SetupModeState {
  const mode = new URLSearchParams(location.search).get('mode') === 'tmdb-gate' ? 'tmdb-gate' : 'settings';
  return {
    mode,
    issue: mode === 'tmdb-gate' ? 'Add a TMDb access token or API key to continue.' : '',
    hasSavedTmdbCredential: false,
  };
}

function delayedCheck(callback: (result: CheckResult) => void, result: CheckResult, delay: number) {
  window.setTimeout(() => callback(result), delay);
}

function createPreviewSetupApi(): SetupApi {
  let statusListener: ((message: string) => void) | null = null;
  let checkListener: ((result: CheckResult) => void) | null = null;

  return {
    getDefaults: async () => previewDefaults,
    getMode: async () => resolvedPreviewMode(),
    verifySavedCredentials: async () => ({}),
    repairTmdb: async () => {
      statusListener?.('Connected.');
      checkListener?.({ id: 'tmdb', state: 'passed', message: 'Connected' });
      return { ok: true, next: 'home' };
    },
    chooseDataDirectory: async () => 'C:\\TorWatch',
    test: async (_configuration: SetupFormValues) => {
      if (checkListener) {
        delayedCheck(checkListener, { id: 'tmdb', state: 'passed', message: 'Connected' }, 120);
        delayedCheck(checkListener, { id: 'docker', state: 'skipped', message: 'Set up later' }, 220);
        delayedCheck(checkListener, { id: 'services', state: 'skipped', message: 'Set up later' }, 320);
      }
      statusListener?.('Ready.');
      return { ok: true };
    },
    complete: async (): Promise<SetupResult> => ({ ok: true }),
    installDocker: async () => ({ ok: true }),
    openGuide: async () => ({ ok: true }),
    openTmdbGuide: async () => ({ ok: true }),
    openOpenSubtitlesGuide: async () => ({ ok: true }),
    openVpnGuide: async () => ({ ok: true }),
    openProwlarr: async () => ({ ok: true }),
    openProwlarrGuide: async () => ({ ok: true }),
    onStatus: (callback) => { statusListener = callback; },
    onCheck: (callback) => { checkListener = callback; },
    onMode: () => undefined,
  };
}

export function createSetupApi(): SetupApi {
  return window.setupAPI ?? createPreviewSetupApi();
}
