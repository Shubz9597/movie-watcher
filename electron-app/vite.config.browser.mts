// Browser/mobile preview build (feature 002 M1.2, change-map M1.2 row):
// a SEPARATE entry and output directory so a mobile build can never wipe
// Electron's dist/. Same aliases and CSP origin injection as the Electron
// build; the fixture origin is additionally allowed for dev captures.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'node:fs';
import { fileURLToPath } from 'url';
import { resolveBackendOrigin } from './backend-origin.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const backendOriginHtmlPlugin = () => {
  const origin = resolveBackendOrigin(process.env);
  return {
    name: 'torwatch-backend-origin-csp-browser',
    transformIndexHtml(html) {
      return html.split('__TORWATCH_BACKEND_ORIGIN__').join(origin);
    },
  };
};

const mobileInstallAssetsPlugin = () => ({
  name: 'torwatch-mobile-install-assets',
  generateBundle() {
    // True 512x512 square icon (generated from the artwork; the original
    // torwatch-app-icon.png is 1672x941 and must NOT be advertised as 512x512).
    this.emitFile({
      type: 'asset',
      fileName: 'torwatch-app-icon.png',
      source: fs.readFileSync(path.resolve(__dirname, 'src/assets/torwatch-app-icon-512.png')),
    });
    this.emitFile({
      type: 'asset',
      fileName: 'manifest.webmanifest',
      source: JSON.stringify({
        name: 'TorWatch',
        short_name: 'TorWatch',
        description: 'Your private household cinema.',
        start_url: './browser.html',
        scope: './',
        display: 'standalone',
        background_color: '#0a0a0a',
        theme_color: '#0a0a0a',
        icons: [{
          src: './torwatch-app-icon.png',
          sizes: '512x512',
          type: 'image/png',
          purpose: 'any',
        }],
      }, null, 2),
    });
  },
});

export default defineConfig({
  base: './',
  plugins: [react(), backendOriginHtmlPlugin(), mobileInstallAssetsPlugin()],
  root: './src',
  build: {
    outDir: '../dist-browser',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        browser: path.resolve(__dirname, 'src/browser.html'),
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
