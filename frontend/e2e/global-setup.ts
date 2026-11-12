import type { FullConfig } from "@playwright/test";

// The test web server is `next dev`: it compiles each route the first time it is requested. On the
// slow development disk a first compile can take many seconds and holds up everything else the
// server is doing at that moment, so a story that happens to be first on a route can run out of its
// visibility window for reasons that have nothing to do with the app. Every route the stories visit
// is requested once here, before any test starts, so the tests only meet compiled routes.
//
// This hides nothing: a route that fails to compile or answers with a server error fails the run
// here, with the route named. Shell pages are guarded in the browser, so without a session they
// still render (and compile) on the server.

const SAMPLE_ID = "00000000-0000-4000-8000-000000000000";

/** Every page the stories open, by direct visit or by a link click (client navigation). */
const ROUTES = [
  "/sign-in",
  "/activate",
  "/ops/sign-in",
  "/ops",
  "/ops/new",
  "",
  "/more",
  "/more/settings",
  "/more/stores",
  "/more/stores/new",
  `/more/stores/${SAMPLE_ID}`,
  "/more/employees",
  "/more/employees/invite",
  `/more/employees/${SAMPLE_ID}`,
];

const LOCALES = ["en", "ar"];

// A first compile on the slow disk takes seconds, rarely a minute; a route still not answering
// after this long is a real failure.
const PER_ROUTE_TIMEOUT_MS = 180_000;

async function warm(url: string): Promise<void> {
  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(PER_ROUTE_TIMEOUT_MS), redirect: "manual" });
    await response.arrayBuffer();
  } catch (error) {
    throw new Error(`Warm-up: ${url} did not answer (${error instanceof Error ? error.message : String(error)})`);
  }
  if (response.status >= 500) throw new Error(`Warm-up: ${url} answered ${response.status}`);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (process.env.BOS_E2E_WARMUP_LOG) console.log(`warm-up ${response.status} ${seconds}s ${url}`);
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error("Warm-up: no baseURL in playwright.config.ts");
  const started = Date.now();
  // One at a time: parallel first compiles on this disk are slower than serial ones.
  for (const locale of LOCALES) {
    for (const route of ROUTES) await warm(`${baseURL}/${locale}${route}`);
  }
  // The /api/v1 forwarding as well (the first proxied request sets the rewrite up).
  await warm(`${baseURL}/api/v1/health`);
  console.log(`Warm-up: ${LOCALES.length * ROUTES.length + 1} requests in ${((Date.now() - started) / 1000).toFixed(0)}s`);
}
