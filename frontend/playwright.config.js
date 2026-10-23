import { defineConfig, devices } from '@playwright/test';

// Dedicated ports so E2E never collides with a running dev server.
const API_PORT = 8010;
const WEB_PORT = 5183;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1, // WebGL (SwiftShader) is CPU-heavy: parallel workers time out on a busy machine

  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  projects: [{
    name: 'chromium',
    use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 },
      // A fake microphone (a tone) with auto-granted permission, for the voice tests.
      launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } },
  }],
  webServer: [
    {
      command: `uv run uvicorn app.main:app --port ${API_PORT}`,
      cwd: '../backend',
      url: `http://localhost:${API_PORT}/api/health`,
      // No keys: E2E never calls OpenAI or Supabase (it would read backend/.env otherwise). Agent tests
      // mock /api; saved designs use the backend's in-memory store.
      env: { APP_ENV: 'e2e', CORS_ORIGINS: `http://localhost:${WEB_PORT}`, OPENAI_API_KEY: '', SUPABASE_URL: '', SUPABASE_SECRET_KEY: '' },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `npx vite --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      env: { VITE_API_BASE_URL: `http://localhost:${API_PORT}` },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
