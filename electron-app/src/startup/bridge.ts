export type StartupApi = {
  onStatus: (callback: (message: string) => void) => void;
};

declare global {
  interface Window {
    startupAPI?: StartupApi;
  }
}

function createPreviewStartupApi(): StartupApi {
  return {
    onStatus(callback) {
      window.setTimeout(() => callback('Checking TMDb...'), 500);
      window.setTimeout(() => callback('Starting playback services...'), 1100);
    },
  };
}

export function createStartupApi(): StartupApi {
  return window.startupAPI ?? createPreviewStartupApi();
}
