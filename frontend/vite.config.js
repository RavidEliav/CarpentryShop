import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173 },
  build: { rollupOptions: { input: ['index.html', 'accessibility.html'] } },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.js'],
    coverage: { provider: 'v8', include: ['src/**/*.js'], thresholds: { 'src/domain/**': { lines: 80 } } },
  },
});
