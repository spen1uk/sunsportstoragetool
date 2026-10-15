import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: { outDir: path.join(import.meta.dirname, 'dist'), emptyOutDir: true, rollupOptions: { input: { main: path.join(import.meta.dirname, 'index.html'), go: path.join(import.meta.dirname, 'go.html') } }, chunkSizeWarningLimit: 900 },
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:8788' } } },
});
