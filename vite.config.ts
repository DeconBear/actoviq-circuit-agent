import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  root: path.resolve(import.meta.dirname, 'renderer'),
  base: './',
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist-renderer'),
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
});
