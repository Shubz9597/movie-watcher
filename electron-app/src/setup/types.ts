export type SetupMode = 'settings' | 'tmdb-gate';

export type CheckState = 'waiting' | 'running' | 'passed' | 'failed' | 'skipped';

export type CredentialState = '' | 'saved' | 'checking' | 'connected' | 'changed' | 'failed';

export type SetupModeState = {
  mode: SetupMode;
  issue: string;
  hasSavedTmdbCredential: boolean;
};

export type SetupDefaults = {
  dataDir?: string;
  setupComplete?: boolean;
  vpnProvider?: string;
  vpnType?: string;
  vpnAddresses?: string;
  serverCities?: string;
  hasTmdbKey?: boolean;
  hasOpenSubApiKey?: boolean;
  hasOpenSubUserToken?: boolean;
  hasVpnPrivateKey?: boolean;
};

export type SetupFormValues = {
  dataDir: string;
  tmdbKey: string;
  openSubApiKey: string;
  openSubUserToken: string;
  clearOpenSubUserToken: boolean;
  clearVpnConfiguration: boolean;
  vpnProvider: string;
  vpnType: string;
  vpnPrivateKey: string;
  vpnAddresses: string;
  serverCities: string;
};

export type CredentialBadgeState = {
  state: CredentialState;
  message: string;
};

export type CheckResult = {
  id: string;
  state: CheckState;
  message: string;
};

export type SetupResult = {
  ok: boolean;
  error?: string;
  warning?: string;
  failedCheck?: string;
  next?: 'setup' | 'home';
};

export type SavedCredentialResults = {
  tmdb?: CredentialBadgeState;
  openSubtitles?: CredentialBadgeState;
};

export type SetupApi = {
  getDefaults: () => Promise<SetupDefaults>;
  getMode: () => Promise<SetupModeState>;
  verifySavedCredentials: () => Promise<SavedCredentialResults>;
  repairTmdb: (replacement: string) => Promise<SetupResult>;
  chooseDataDirectory: () => Promise<string | null>;
  test: (configuration: SetupFormValues) => Promise<SetupResult>;
  complete: () => Promise<SetupResult>;
  installDocker: () => Promise<{ ok: boolean }>;
  openGuide: () => Promise<{ ok: boolean }>;
  openTmdbGuide: () => Promise<{ ok: boolean }>;
  openOpenSubtitlesGuide: () => Promise<{ ok: boolean }>;
  openVpnGuide: () => Promise<{ ok: boolean }>;
  openProwlarr: () => Promise<{ ok: boolean }>;
  openProwlarrGuide: () => Promise<{ ok: boolean }>;
  onStatus: (callback: (message: string) => void) => void;
  onCheck: (callback: (result: CheckResult) => void) => void;
  onMode: (callback: (state: SetupModeState) => void) => void;
};
