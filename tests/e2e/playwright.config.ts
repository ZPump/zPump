import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './src',
  timeout: 600_000,
  expect: {
    timeout: 30_000
  },
  use: {
    headless: true
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' }
    }
  ]
});
