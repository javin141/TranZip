import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Gives public/sw.js a new cache name on every build. Without this its bytes
// would never change, so browsers would never install it as an update and
// old shell caches would never be cleared.
function stampServiceWorker() {
  let outDir = 'dist';
  return {
    name: 'tranzip-stamp-service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const file = path.join(outDir, 'sw.js');
      if (!existsSync(file)) return;
      writeFileSync(file, readFileSync(file, 'utf8').replaceAll('__BUILD_ID__', Date.now().toString(36)));
    },
  };
}

// The browser never talks to LTA DataMall / OneMap directly:
// every data call goes through the Express proxy in /server so the
// AccountKey and OneMap token stay server-side.
const API_TARGET = process.env.API_TARGET || 'http://localhost:8787';

export default defineConfig({
  plugins: [react(), stampServiceWorker()],
  server: {
    port: 5173,
    open: true,
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
    // Never source, always noise - and a large archive being written live
    // (e.g. a backup tool) can hold an OS-level lock that crashes chokidar
    // with EBUSY if the watcher tries to pick it up mid-write.
    watch: {
      ignored: ['**/*.zip', '**/.cache.zip'],
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});