import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for Maria end-to-end tests.
 *
 * By default, tests run against the production Railway URL.
 * Override with: BASE_URL=http://localhost:5173 npx playwright test
 *
 * The backend API URL is derived from BASE_URL:
 *   - Production: same origin (backend serves frontend)
 *   - Local dev: http://localhost:3001
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,       // Tests share state (login, created data) — run serially
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,                 // Serial execution — tests depend on prior test state
  reporter: 'html',
  timeout: 120_000,           // 2 minutes per test — Maria AI responses can be slow

  use: {
    baseURL: process.env.BASE_URL || 'https://glorious-benevolence-production-c1e0.up.railway.app',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
