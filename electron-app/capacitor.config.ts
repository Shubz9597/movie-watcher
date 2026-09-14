import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor shell configuration (feature 002 M1.4.2).
 *
 * appId `com.torwatch.mobile` is a PLACEHOLDER for development: change it to
 * the final release identifier BEFORE any release/signing work (M5) — a
 * signed store identity can never be changed after first publication.
 *
 * webDir is the dedicated mobile production bundle (dist-mobile), built by
 * vite.config.mobile.mts from the SAME shared React UI as desktop/browser.
 */
const config: CapacitorConfig = {
  appId: 'com.torwatch.mobile',
  appName: 'TorWatch',
  webDir: 'dist-mobile',
  backgroundColor: '#0a0a0a',
  // No baked server URL: the backend origin is user-configured at runtime
  // (M1.4.6 settings flow) and persisted on-device.
  server: {
    androidScheme: 'https',
  },
  ios: {
    contentInset: 'never',
  },
};

export default config;
