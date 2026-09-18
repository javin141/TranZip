import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The browser never talks to LTA DataMall / OneMap directly:
// every data call goes through the Express proxy in /server so the
// AccountKey and OneMap token stay server-side.
const API_TARGET = process.env.API_TARGET || 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});