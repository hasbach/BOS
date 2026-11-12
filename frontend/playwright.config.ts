import { defineConfig } from "@playwright/test";
import { join } from "node:path";

// End-to-end tests (task T036). They drive an installed browser (Edge; set BOS_E2E_BROWSER=chrome
// to use Chrome instead): nothing is downloaded. They start their own web server on port 3200 with
// its own build folder, so the development server on 3100 is never touched, and use the BOS API on
// 5100 (BOS_E2E_API_PORT overrides it; started here unless one is already running). The API uses the development database.

const WEB_PORT = 3200;
const API_PORT = Number(process.env.BOS_E2E_API_PORT ?? 5100);
const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
const channel = process.env.BOS_E2E_BROWSER === "chrome" ? "chrome" : "msedge";

const uv = join(process.env.USERPROFILE ?? "", ".local", "bin", "uv.exe");
const nextBin = join("node_modules", "next", "dist", "bin", "next");

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    baseURL: WEB_ORIGIN,
    channel,
    viewport: { width: 360, height: 740 },
    trace: "retain-on-failure",
  },
  projects: [
    { name: "en", use: { locale: "en-US" } },
    { name: "ar", use: { locale: "ar" } },
  ],
  webServer: [
    {
      // Links the API builds (activation, reset) point at the web server used by the tests.
      command: `"${uv}" run python scripts/local_api.py serve --port ${API_PORT} --public-base-url ${WEB_ORIGIN}`,
      cwd: "../backend",
      url: `http://127.0.0.1:${API_PORT}/api/v1/health`,
      // An API that is already running (for example the one behind the development server) is
      // used as it is. Tests rebase the links it returns onto the test web server.
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: `"${process.execPath}" ${nextBin} dev -H 127.0.0.1 -p ${WEB_PORT}`,
      url: `${WEB_ORIGIN}/en/sign-in`,
      reuseExistingServer: false,
      timeout: 240_000,
      env: {
        BOS_API_INTERNAL_URL: `http://127.0.0.1:${API_PORT}`,
        // A separate build folder: two `next dev` servers cannot share one.
        BOS_NEXT_DIST_DIR: ".next-e2e",
      },
    },
  ],
});
