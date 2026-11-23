import { defineConfig } from "@playwright/test";

// Deliberately separate from e2e: no shared database, builds, web servers, setup or teardown.
export default defineConfig({
  testDir: ".",
  testMatch: "m1.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3217",
    channel: "msedge",
    viewport: { width: 360, height: 740 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 11; Moto G Power) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Mobile Safari/537.36",
    serviceWorkers: "block",
  },
  projects: [{ name: "en", use: { locale: "en-US" } }, { name: "ar", use: { locale: "ar" } }],
});
