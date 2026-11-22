import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import CatalogPage from "@/app/[locale]/(shell)/more/catalog/page";
import { MeContext } from "@/lib/session";

import en from "../../messages/en.json";
import { catalogOwner, catalogStaff, page, summary } from "../helpers/catalog";
import { reply } from "../helpers/fetch";
import { renderMe } from "../helpers/shell";

const { cookies } = vi.hoisted(() => ({ cookies: vi.fn() }));
vi.mock("next/headers", () => ({ cookies }));
vi.mock("next-intl/server", () => ({ setRequestLocale: vi.fn() }));
vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);

afterEach(() => vi.unstubAllGlobals());

const product = summary({ id: "p-jeans", main_photo_id: null });

function setup(me = catalogOwner(), body: unknown = page([product]), token: string | undefined = "session_test") {
  cookies.mockResolvedValue({ get: (name: string) => name === "bos_session" && token ? { value: token } : undefined });
  const fetch = vi.fn(async (url: string) => reply(200, url.endsWith("/me") ? me : body));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function open(noPhoto?: string) {
  return CatalogPage({ params: Promise.resolve({ locale: "en" }), searchParams: Promise.resolve({ no_photo: noPhoto }) });
}

describe("server catalog page", () => {
  it.each([
    ["default", catalogOwner(), undefined, ""],
    ["no-photo manager", catalogOwner(), "1", "?no_photo=true"],
    ["no-photo staff", catalogStaff(), "1", ""],
  ] as const)("loads the %s list using the session and no shared cache", async (_name, me, noPhoto, suffix) => {
    const fetch = setup(me);
    const element = await open(noPhoto);
    expect(fetch.mock.calls.map(([url]) => new URL(url).pathname + new URL(url).search)).toEqual(["/api/v1/me", `/api/v1/catalog/products${suffix}`]);
    expect(fetch).toHaveBeenLastCalledWith(expect.stringContaining("/api/v1/catalog/products"), expect.objectContaining({
      cache: "no-store", redirect: "manual", headers: { Accept: "application/json", Cookie: "bos_session=session_test" },
    }));
    renderMe(element, me);
    expect(screen.getByText("Slim blue jeans")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["lost manage", catalogOwner(), catalogStaff(), "?no_photo=true", ""],
    ["gained manage", catalogStaff(), catalogOwner(), "", "?no_photo=true"],
  ] as const)("rejects a refresh seed for a different no-photo query when the server session %s", async (_name, mountedMe, serverMe, clientQuery, serverQuery) => {
    setup(mountedMe);
    const first = await open("1");
    const seeded = summary({ id: "p-mismatch", name_en: "Mismatched seeded rows" });
    const serverFetch = setup(serverMe, page([seeded], { next_cursor: "wrong-cursor" }));
    const refreshed = await open("1");
    expect(new URL(serverFetch.mock.calls[1]![0]).search).toBe(serverQuery);

    const clientResult = summary({ id: "p-current", name_en: "Current query rows" });
    const clientFetch = vi.fn(() => reply(200, page([clientResult])));
    vi.stubGlobal("fetch", clientFetch);
    const { rerender } = render(first, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <NextIntlClientProvider locale="en" messages={en}>
          <MeContext.Provider value={mountedMe}>{children}</MeContext.Provider>
        </NextIntlClientProvider>
      ),
    });
    expect(screen.getByText("Slim blue jeans")).toBeInTheDocument();
    expect(clientFetch).not.toHaveBeenCalled();

    rerender(refreshed);
    expect(screen.queryByText("Mismatched seeded rows")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
    expect(await screen.findByText("Current query rows")).toBeInTheDocument();
    expect(clientFetch).toHaveBeenCalledExactlyOnceWith(`/api/v1/catalog/products${clientQuery}`, expect.anything());
  });

  it.each([
    ["missing session", catalogOwner(), "", 0],
    ["locale mismatch", catalogOwner({ user: { ...catalogOwner().user, locale: "ar" } }), "session_test", 1],
    ["no catalog permission", catalogOwner({ permissions: [] }), "session_test", 1],
  ] as const)("does not load catalog data with %s", async (_name, me, token, calls) => {
    const fetch = setup(me, undefined, token);
    await open();
    expect(fetch).toHaveBeenCalledTimes(calls);
    if (calls) expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/me$/), expect.anything());
  });

  it("falls back to the browser for an unusable server page", async () => {
    const fetch = setup(catalogOwner(), { ...page([product]), items: [{ ...product, prices: null }] });
    const element = await open();
    expect(fetch).toHaveBeenCalledTimes(2);
    const clientFetch = vi.fn(() => reply(200, page([product])));
    vi.stubGlobal("fetch", clientFetch);
    renderMe(element, catalogOwner());
    expect(await screen.findByText("Slim blue jeans")).toBeInTheDocument();
    expect(clientFetch).toHaveBeenCalledTimes(1);
  });

  it("retries the browser first page on refresh when neither server render supplies data", async () => {
    const me = catalogOwner();
    setup(me, null);
    const first = await open();
    const refreshed = await open();
    const updated = summary({ id: "p-updated", name_en: "Refreshed jeans" });
    const clientFetch = vi.fn()
      .mockImplementationOnce(() => reply(200, page([product])))
      .mockImplementationOnce(() => reply(200, page([updated])));
    vi.stubGlobal("fetch", clientFetch);
    const { rerender } = render(first, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <NextIntlClientProvider locale="en" messages={en}>
          <MeContext.Provider value={me}>{children}</MeContext.Provider>
        </NextIntlClientProvider>
      ),
    });
    await screen.findByText("Slim blue jeans");

    rerender(refreshed);
    expect(clientFetch).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("Refreshed jeans")).toBeInTheDocument();
    expect(screen.queryByText("Slim blue jeans")).not.toBeInTheDocument();
  });
});
