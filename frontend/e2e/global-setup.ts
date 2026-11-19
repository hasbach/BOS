import { randomBytes } from "node:crypto";

import type { APIRequestContext, FullConfig } from "@playwright/test";

import { loadEnv } from "./env";
import { createBusinessApi, newApi, operatorSignInApi, rebase } from "./fixtures";

// The test web server is `next dev`: it compiles each route the first time it is requested. On the
// slow development disk a first compile can take many seconds and holds up everything else the
// server is doing at that moment, so a story that happens to be first on a route can run out of its
// visibility window for reasons that have nothing to do with the app. Every route the stories visit
// is requested once here, before any test starts, so the tests only meet compiled routes.
//
// This hides nothing: a route that fails to compile or answers with a server error fails the run
// here, with the route named.
//
// Signed-in pages are rendered on the server with the person (the shell layout asks GET /me itself,
// SC-009, T088). Without a session the server redirects to sign-in before the page renders, and while
// the person's language differs from the address the guard shows only "Checking your session", so in
// both cases the page's own code would not be compiled. The warm-up therefore signs in as a fresh
// owner (a throwaway business, as the stories create) and visits each language's pages with the
// owner's saved language set to that language.

const SAMPLE_ID = "00000000-0000-4000-8000-000000000000";

/** Every page the stories open, by direct visit or by a link click (client navigation). */
const ROUTES = [
  "/sign-in",
  "/activate",
  "/reset",
  "/ops/sign-in",
  "/ops",
  "/ops/new",
  "",
  "/sales",
  "/packing",
  "/delivery",
  "/orders",
  "/more",
  "/more/language",
  "/more/profile",
  "/more/profile/password",
  "/more/history",
  "/more/devices",
  "/more/settings",
  "/more/stores",
  "/more/stores/new",
  `/more/stores/${SAMPLE_ID}`,
  "/more/employees",
  "/more/employees/invite",
  `/more/employees/${SAMPLE_ID}`,
  `/more/employees/invitations/${SAMPLE_ID}`,
  // M1 (m1-catalog.spec.ts, m1-stock.spec.ts)
  "/more/catalog",
  "/more/catalog/new",
  `/more/catalog/${SAMPLE_ID}`,
  `/more/catalog/${SAMPLE_ID}/edit`,
  `/more/catalog/${SAMPLE_ID}/variants/${SAMPLE_ID}/history`,
];

const LOCALES = ["en", "ar"] as const;

// A first compile on the slow disk takes seconds, rarely a minute; a route still not answering
// after this long is a real failure.
const PER_ROUTE_TIMEOUT_MS = 180_000;

async function warm(owner: APIRequestContext, url: string): Promise<void> {
  const started = Date.now();
  let status: number;
  try {
    // Redirects are not followed: home answers with one to the start tab, which is warmed on its own.
    const response = await owner.get(url, { timeout: PER_ROUTE_TIMEOUT_MS, maxRedirects: 0 });
    await response.body();
    status = response.status();
  } catch (error) {
    throw new Error(`Warm-up: ${url} did not answer (${error instanceof Error ? error.message : String(error)})`);
  }
  if (status >= 500) throw new Error(`Warm-up: ${url} answered ${status}`);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (process.env.BOS_E2E_WARMUP_LOG) console.log(`warm-up ${status} ${seconds}s ${url}`);
}

/** A signed-in owner of a new business, through the web server's /api/v1 forward like the browser. */
async function signedInOwner(baseURL: string): Promise<APIRequestContext> {
  const ops = await newApi(baseURL);
  await operatorSignInApi(ops, loadEnv());
  const business = await createBusinessApi(ops);
  await ops.dispose();
  const owner = await newApi(baseURL);
  const accepted = await owner.post("/api/v1/invitations/accept", {
    data: { token: rebase(business.link, baseURL).token, password: `${randomBytes(18).toString("base64url")}aA1!`, locale: "en" },
  });
  if (accepted.status() !== 200) throw new Error(`Warm-up: owner activation answered ${accepted.status()}`);
  return owner;
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error("Warm-up: no baseURL in playwright.config.ts");
  const started = Date.now();
  // The /api/v1 forwarding first (the first proxied request sets the rewrite up).
  const probe = await newApi(baseURL);
  await warm(probe, `${baseURL}/api/v1/health`);
  await probe.dispose();

  const owner = await signedInOwner(baseURL);
  try {
    // One at a time: parallel first compiles on this disk are slower than serial ones.
    for (const locale of LOCALES) {
      const saved = await owner.patch("/api/v1/me", { data: { locale } });
      if (saved.status() !== 200) throw new Error(`Warm-up: saving the language answered ${saved.status()}`);
      for (const route of ROUTES) await warm(owner, `${baseURL}/${locale}${route}`);
    }
  } finally {
    await owner.dispose();
  }
  console.log(`Warm-up: ${LOCALES.length * ROUTES.length + 1} requests in ${((Date.now() - started) / 1000).toFixed(0)}s`);
}
