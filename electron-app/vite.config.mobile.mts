// Native mobile production build (feature 002 M1.4.2): the SAME shared React
// UI as desktop/browser, packaged for Capacitor into dist-mobile.
//
// Differences from the browser build:
//   - No `?server=` query-parameter origin: the backend origin is USER
//     CONFIGURED at runtime (M1.4.6 onboarding/settings) and persisted on
//     device. Nothing is baked at build time.
//   - Separate entry (src/mobile.html → src/mobile/main.tsx) so the native
//     playback path (Capacitor bridge) is bundled instead of the browser
//     staging player.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: './',
  plugins: [react()],
  root: './src',
  build: {
    outDir: '../dist-mobile',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        mobile: path.resolve(__dirname, 'src/mobile.html'),
      },
    },
  },
  resolve: {
    alias: {
      'next/navigation': path.resolve(__dirname, 'src/lib/next-navigation-adapter.ts'),
      'next/link': path.resolve(__dirname, 'src/lib/next-link-adapter.tsx'),
      'next/image': path.resolve(__dirname, 'src/lib/next-image-adapter.tsx'),
    },
  },
  publicDir: false,
});
