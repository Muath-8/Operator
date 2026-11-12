import { defineConfig, devices } from '@playwright/test';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * UI suite against the TEST-ONLY harness (real components + explicit fixtures), served on its own
 * loopback port. Run: pnpm exec playwright test -c apps/web/tests/ui/playwright.config.ts
 * Needs @playwright/test, esbuild and axe-core (root installs). Uses Playwright's Chromium by default;
 * set UI_BROWSER_CHANNEL (for example "msedge" or "chrome") to use an installed browser instead.
 * Screenshot baselines live in __screenshots__ and are accepted only after a person reviews them.
 */
const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.UI_HARNESS_PORT ?? 4317);
const base = `http://127.0.0.1:${port}/`;
process.env.UI_HARNESS_URL ??= base;
const channel = process.env.UI_BROWSER_CHANNEL;

export default defineConfig({
  testDir: here,
  testMatch: /.*\.spec\.ts$/,
  outputDir: `${here}/test-results`,
  snapshotPathTemplate: `${here}/__screenshots__/{projectName}/{arg}{ext}`,
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  retries: 0,
  reporter: [['list']],
  expect: { toHaveScreenshot: { animations: 'disabled', caret: 'hide' } },
  use: {
    baseURL: base,
    ...devices['Desktop Chrome'],
    ...(channel ? { channel } : {}),
    reducedMotion: 'reduce',
    locale: 'en-GB',
    timezoneId: 'Asia/Riyadh',
  },
  projects: [{ name: channel ?? 'chromium' }],
  webServer: {
    command: 'node harness/serve.mjs',
    cwd: here,
    url: base,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
  },
});
