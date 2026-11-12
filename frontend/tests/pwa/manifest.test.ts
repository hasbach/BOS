import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// T076: the manifest is valid and the service worker keeps only static shell files, never the API.

const PUBLIC = resolve(process.cwd(), "public");
const read = (file: string) => readFileSync(resolve(PUBLIC, file), "utf-8");

interface Manifest {
  name: string;
  short_name?: string;
  display: string;
  start_url: string;
  scope?: string;
  icons: Array<{ src: string; sizes: string; type: string; purpose?: string }>;
  theme_color?: string;
  background_color?: string;
}

describe("web app manifest", () => {
  const manifest = JSON.parse(read("manifest.webmanifest")) as Manifest;

  it("is named BOS and opens full-screen", () => {
    expect(manifest.name).toBe("BOS");
    expect(manifest.display).toBe("standalone");
  });

  it("has a start_url inside its scope", () => {
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope ?? "/").toBe("/");
  });

  it("has colours for the splash screen and browser bar", () => {
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("has 192 and 512 pixel PNG icons that exist and really are that size", () => {
    for (const size of [192, 512]) {
      const icon = manifest.icons.find((candidate) => candidate.sizes === `${size}x${size}` && (candidate.purpose ?? "any") === "any");
      expect(icon, `${size}px icon`).toBeTruthy();
      expect(icon?.type).toBe("image/png");
      const file = readFileSync(resolve(PUBLIC, (icon?.src ?? "").replace(/^\//, "")));
      expect(file.subarray(1, 4).toString("ascii")).toBe("PNG");
      expect(file.readUInt32BE(16)).toBe(size);
      expect(file.readUInt32BE(20)).toBe(size);
    }
  });

  it("only points at files that exist", () => {
    for (const icon of manifest.icons) expect(() => readFileSync(resolve(PUBLIC, icon.src.replace(/^\//, "")))).not.toThrow();
  });
});

// ---- The service worker, run in a sandbox with a minimal stand-in for the worker scope ---------------

type Listener = (event: Record<string, unknown>) => void;

function loadWorker() {
  const listeners: Record<string, Listener> = {};
  const stored = new Map<string, Map<string, unknown>>();
  const cache = (name: string) => {
    if (!stored.has(name)) stored.set(name, new Map());
    const entries = stored.get(name) as Map<string, unknown>;
    return {
      match: async (request: { url: string }) => entries.get(request.url),
      put: async (request: { url: string }, response: unknown) => void entries.set(request.url, response),
      addAll: async () => undefined,
    };
  };
  const self = {
    addEventListener: (type: string, listener: Listener) => void (listeners[type] = listener),
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
    location: { origin: "https://bos.example" },
  };
  const caches = {
    open: async (name: string) => cache(name),
    keys: async () => [...stored.keys()],
    delete: async (name: string) => stored.delete(name),
  };
  const fetched: string[] = [];
  const fetchFn = async (request: { url: string }) => {
    fetched.push(request.url);
    return { ok: true, status: 200, type: "basic", url: request.url, clone() { return this; } };
  };
  const sandbox = createContext({ self, caches, fetch: fetchFn, URL, Promise, console });
  runInContext(read("sw.js"), sandbox);
  return { listeners, stored, fetched };
}

interface FakeFetchEvent {
  request: { url: string; method: string; mode: string; destination: string };
  respondWith: (value: Promise<unknown>) => void;
  waitUntil: (value: Promise<unknown>) => void;
}

/** Fires a fetch event; returns whether the worker took the request over. */
async function fire(listeners: Record<string, Listener>, url: string, init: Partial<FakeFetchEvent["request"]> = {}): Promise<boolean> {
  let taken = false;
  const pending: Array<Promise<unknown>> = [];
  const event: FakeFetchEvent = {
    request: { url, method: "GET", mode: "cors", destination: "", ...init },
    respondWith: (value) => {
      taken = true;
      pending.push(value);
    },
    waitUntil: (value) => void pending.push(value),
  };
  listeners.fetch?.(event as unknown as Record<string, unknown>);
  await Promise.all(pending);
  return taken;
}

describe("service worker", () => {
  const origin = "https://bos.example";

  it("never touches the API: not a read, not a write, not with any query string", async () => {
    const { listeners, stored } = loadWorker();
    for (const path of ["/api/v1/me", "/api/v1/me/sessions", "/api/v1/audit?cursor=abc", "/api/v1/stores/1/logo", "/api/"]) {
      expect(await fire(listeners, `${origin}${path}`), path).toBe(false);
      expect(await fire(listeners, `${origin}${path}`, { method: "POST" }), `POST ${path}`).toBe(false);
    }
    expect([...stored.values()].every((entries) => [...entries.keys()].every((url) => !url.includes("/api/")))).toBe(true);
  });

  it("does not take over page navigations or any non-GET request", async () => {
    const { listeners } = loadWorker();
    expect(await fire(listeners, `${origin}/en/sales`, { mode: "navigate", destination: "document" })).toBe(false);
    expect(await fire(listeners, `${origin}/_next/static/chunks/app.js`, { method: "POST" })).toBe(false);
  });

  it("ignores other origins", async () => {
    const { listeners } = loadWorker();
    expect(await fire(listeners, "https://elsewhere.example/_next/static/x.js")).toBe(false);
  });

  it("keeps static shell files: the built scripts, styles and fonts, and the icons", async () => {
    const { listeners, stored } = loadWorker();
    for (const path of ["/_next/static/chunks/app.js", "/_next/static/css/app.css", "/_next/static/media/inter.woff2", "/icons/icon-192.png"]) {
      expect(await fire(listeners, `${origin}${path}`), path).toBe(true);
    }
    const cached = [...stored.values()].flatMap((entries) => [...entries.keys()]);
    expect(cached).toContain(`${origin}/_next/static/chunks/app.js`);
    expect(cached.every((url) => !url.includes("/api/"))).toBe(true);
  });

  it("answers a repeat request for a static file from the cache", async () => {
    const { listeners, fetched } = loadWorker();
    const url = `${origin}/_next/static/chunks/app.js`;
    await fire(listeners, url);
    await fire(listeners, url);
    expect(fetched.filter((fetchedUrl) => fetchedUrl === url)).toHaveLength(1);
  });

  it("removes caches of older versions when it activates", async () => {
    const { listeners, stored } = loadWorker();
    stored.set("bos-shell-v0-old", new Map());
    const pending: Array<Promise<unknown>> = [];
    listeners.activate?.({ waitUntil: (value: Promise<unknown>) => void pending.push(value) });
    await Promise.all(pending);
    expect([...stored.keys()]).not.toContain("bos-shell-v0-old");
  });

  it("source never mentions an API path as something to cache", () => {
    const source = read("sw.js");
    expect(source).not.toMatch(/addAll\(\s*\[[^\]]*\/api/);
    expect(source).toMatch(/\/api\//);
  });
});
