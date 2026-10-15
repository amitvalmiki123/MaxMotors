import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    allowedHosts: ['.e2b.app'],
  },
  preview: {
    host: '0.0.0.0',
    allowedHosts: ['.e2b.app'],
  },
  build: {
    chunkSizeWarningLimit: 750,
    rolldownOptions: {
      output: {
        // Engine libraries get their own long-cached chunks, so app code changes
        // never re-download three.js, and no single chunk crosses the warning
        // limit as features land (the app chunk used to sit at ~749.8 kB).
        codeSplitting: {
          groups: [
            { name: 'three', test: /node_modules[\\/]three[\\/]build[\\/]/ },
            { name: 'physics', test: /node_modules[\\/]cannon-es[\\/]/ },
          ],
        },
      },
    },
  },
});
