const { contextBridge } = require('electron');

const runtimeState = {
  status: 'error',
  message: 'Playback services could not start. Check your connection and try again.',
  code: 'RUNTIME_START_FAILED',
};
let runtimeCallback = null;

contextBridge.exposeInMainWorld('electronAPI', {
  getConfig: async () => ({}),
  getRuntimeState: async () => runtimeState,
  onRuntimeState: (callback) => { runtimeCallback = callback; },
  emitRuntimeState: () => runtimeCallback?.(runtimeState),
  retryRuntime: async () => ({ ok: false, state: runtimeState }),
  openSetup: async () => ({ ok: true }),
});
