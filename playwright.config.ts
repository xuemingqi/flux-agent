import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:4318',
    channel: process.env.PLAYWRIGHT_CHANNEL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'node tests/fixtures/model-server.mjs',
      url: 'http://127.0.0.1:4319/health',
      reuseExistingServer: false,
    },
    {
      command: 'node tests/fixtures/start-app.mjs',
      url: 'http://127.0.0.1:4318',
      reuseExistingServer: false,
      env: {
        PORT: '4318',
        MODEL_BASE_URL: 'http://127.0.0.1:4319/v1',
        MODEL_NAME: 'fixture-model',
        MODEL_API_KEY: 'fixture-key',
        MODEL_STREAM_USAGE: 'true',
      },
    },
    {
      command: 'node tests/fixtures/start-app.mjs',
      url: 'http://127.0.0.1:4320',
      reuseExistingServer: false,
      env: { PORT: '4320', MODEL_BASE_URL: 'http://127.0.0.1:4319/v1', MODEL_NAME: '', MODEL_API_KEY: '' },
    },
  ],
});
