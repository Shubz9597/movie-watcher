import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  root: './src',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, 'src/index.html'),
    },
  },
  resolve: {
    alias: {
      // Remove @ alias pointing to Next.js - we're now fully standalone
      'next/navigation': path.resolve(__dirname, 'src/lib/next-navigation-adapter.ts'),
      'next/link': path.resolve(__dirname, 'src/lib/next-link-adapter.tsx'),
      'next/image': path.resolve(__dirname, 'src/lib/next-image-adapter.tsx'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  publicDir: false,
});



