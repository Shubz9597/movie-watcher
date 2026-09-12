// M0.2 desktop-smoke preload shim (harness-only; never shipped).
//
// The real main process publishes the catalog state only after its TMDb
// credential flow, which requires a real credential and the Docker runtime —
// neither exists on the M0.2 staging machine. This shim provides the MINIMAL
// electronAPI the Electron entry needs to pass the TmdbConnectionGate so the
// shared UI can be exercised against the M0.2 backend (BFF mode; the provider
// credential is server-side, so the local-credential gate is genuinely
// satisfied by catalog state 'ready'). Playback IPC is intentionally absent:
// the M0.2 smoke does not exercise MPV.
const { contextBridge } = require('electron');

const catalogState = {
  status: 'ready',
  issue: '',
  hasSavedCredential: false,
};

// Runtime status 'idle' renders no status bar (RuntimeStatusBar returns null),
// which is truthful for the harness: playback services are not part of M0.2
// on this machine.
const runtimeState = { status: 'idle', message: '', code: '' };

contextBridge.exposeInMainWorld('electronAPI', {
  getCatalogState: async () => catalogState,
  onCatalogState: (callback) => {
    if (typeof callback === 'function') callback(catalogState);
    return () => undefined;
  },
  getConfig: async () => ({}),
  getRuntimeState: async () => runtimeState,
  onRuntimeState: (callback) => {
    if (typeof callback === 'function') callback(runtimeState);
    return () => undefined;
  },
  retryRuntime: async () => ({ ok: true, state: runtimeState }),
  openSetup: async () => ({ ok: true }),
});
