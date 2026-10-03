import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: { port: 5173 },
  build: { target: 'es2022', chunkSizeWarningLimit: 1000 }, // three.js alone is ~500 kB
  test: { environment: 'node' },
});
