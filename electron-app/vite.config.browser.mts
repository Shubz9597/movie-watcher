// Browser/mobile preview build (feature 002 M1.2, change-map M1.2 row):
// a SEPARATE entry and output directory so a mobile build can never wipe
// Electron's dist/. Same aliases and CSP origin injection as the Electron
// build; the fixture origin is additionally allowed for dev captures.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
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

export default defineConfig({
  base: './',
  plugins: [react(), backendOriginHtmlPlugin()],
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
