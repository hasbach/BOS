import { defineConfig } from "@playwright/test";
import { join } from "node:path";

// End-to-end tests (task T036). They drive an installed browser (Edge; set BOS_E2E_BROWSER=chrome
// to use Chrome instead): nothing is downloaded. They start their own web server on port 3200 with
// its own build folder, so the development server on 3100 is never touched, and use the BOS API on
// 5100 (BOS_E2E_API_PORT overrides it; started here unless one is already running). The API uses the development database.

const WEB_PORT = 3200;
const API_PORT = Number(process.env.BOS_E2E_API_PORT ?? 5100);
// The test web server reaches the API through e2e/api-relay.mjs (see that file for why).
const RELAY_PORT = Number(process.env.BOS_E2E_RELAY_PORT ?? 5180);
const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
const channel = process.env.BOS_E2E_BROWSER === "chrome" ? "chrome" : "msedge";

const uv = join(process.env.USERPROFILE ?? "", ".local", "bin", "uv.exe");
const nextBin = join("node_modules", "next", "dist", "bin", "next");
const next = `"${process.execPath}" ${nextBin}`;
// A production build avoids on-demand compilation timeouts on slower Windows disks.
const production = process.env.BOS_E2E_PRODUCTION === "1";

export default defineConfig({
  testDir: "./e2e",
  // The dev server compiles each page on its first visit; on the slow development disk a
  // whole story can then take over two minutes. Generous, because a hang still fails.
  // global-setup.ts requests every route once first, so the stories themselves rarely compile.
  timeout: 240_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  // Runs after the web servers are up: compiles every route the stories visit before they start.
  globalSetup: "./e2e/global-setup.ts",
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
      command: `"${process.execPath}" e2e/api-relay.mjs ${RELAY_PORT} ${API_PORT}`,
      url: `http://127.0.0.1:${RELAY_PORT}/api/v1/health`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: production
        ? `${next} build && ${next} start -H 127.0.0.1 -p ${WEB_PORT}`
        : `${next} dev -H 127.0.0.1 -p ${WEB_PORT}`,
      url: `${WEB_ORIGIN}/en/sign-in`,
      reuseExistingServer: false,
      timeout: production ? 600_000 : 240_000,
      env: {
        BOS_API_INTERNAL_URL: `http://127.0.0.1:${RELAY_PORT}`,
        // Separate outputs keep test and development builds independent.
        BOS_NEXT_DIST_DIR: ".next-e2e",
      },
    },
  ],
});
