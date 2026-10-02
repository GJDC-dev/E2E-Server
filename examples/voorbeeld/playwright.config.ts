import { defineConfig, devices } from '@playwright/test';

/**
 * Het adres komt uit E2E_BASE_URL: het dashboard zet daar het adres van het
 * testpakket in. Zonder dashboard (lokaal proberen) valt het terug op gjdc.nl.
 */
const baseURL = (process.env.E2E_BASE_URL ?? 'https://gjdc.nl').replace(/\/$/, '');

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'nl-NL',
    timezoneId: 'Europe/Amsterdam',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Een node zonder eigen Playwright-browser kan naar een Chromium van
        // het systeem wijzen (E2E_CHROMIUM_PATH in agent.env).
        ...(process.env.E2E_CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.E2E_CHROMIUM_PATH } } : {}),
      },
    },
    {
      name: 'mobiel',
      use: {
        ...devices['Pixel 7'],
        ...(process.env.E2E_CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.E2E_CHROMIUM_PATH } } : {}),
      },
    },
  ],
});
