import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import EditProductPage from "@/app/[locale]/(shell)/more/catalog/[productId]/edit/page";
import { MeContext } from "@/lib/session";

import ar from "../../messages/ar.json";
import en from "../../messages/en.json";
import { JEANS, catalogApi, catalogOwner, catalogStaff } from "../helpers/catalog";
import { apiError, reply } from "../helpers/fetch";

const { cookies } = vi.hoisted(() => ({ cookies: vi.fn() }));
vi.mock("next/headers", () => ({ cookies }));
vi.mock("next-intl/server", () => ({ setRequestLocale: vi.fn() }));
vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);

afterEach(() => vi.unstubAllGlobals());

const owner = catalogOwner();
const arabicOwner = catalogOwner({ user: { ...owner.user, locale: "ar" } });
const productPath = "/api/v1/catalog/products/p-jeans";

function server(me = owner, productReply = () => reply(200, JEANS), token = "valid_session") {
  cookies.mockResolvedValue({ get: (name: string) => name === "bos_session" && token ? { value: token } : undefined });
  const fetch = vi.fn(async (url: string) => url.endsWith("/me") ? reply(200, me) : productReply());
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function open(locale = "en") {
  return EditProductPage({ params: Promise.resolve({ locale, productId: JEANS.id }) });
}

function wrap(element: ReactNode, me = owner) {
  const locale = me.user.locale;
  return <NextIntlClientProvider locale={locale} messages={locale === "ar" ? ar : en}><MeContext.Provider value={me}>{element}</MeContext.Provider></NextIntlClientProvider>;
}

const nameField = () => screen.getByLabelText(en.catalog.form.nameEn);

describe("server-first product edit", () => {
  it("renders the populated Arabic edit form in the initial HTML", async () => {
    const fetch = server(arabicOwner);
    const html = renderToString(wrap(await open("ar"), arabicOwner));
    expect(html).toContain(`value="${JEANS.name_ar}"`);
    expect(html).toContain("JN-SLIM-32-BLUE");
    expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(["/api/v1/me", productPath]);
    expect(fetch).toHaveBeenLastCalledWith(expect.stringContaining(productPath), expect.objectContaining({
      cache: "no-store", redirect: "manual", method: "GET", headers: { Accept: "application/json", Cookie: "bos_session=valid_session" },
    }));
  });

  it("opens without a client product GET and saves a dirty draft against its displayed version after refresh", async () => {
    server();
    const first = await open();
    server(owner, () => reply(200, { ...JEANS, name_en: "Newer server name", version: 9 }));
    const refreshed = await open();
    server(owner, () => reply(503));
    const unavailable = await open();
    const calls = catalogApi(() => reply(200, JEANS));

    const mounted = render(wrap(first));
    expect(nameField()).toHaveValue(JEANS.name_en);
    fireEvent.change(nameField(), { target: { value: "My unsaved name" } });
    mounted.rerender(wrap(refreshed));
    expect(nameField()).toHaveValue("My unsaved name");
    expect(screen.queryByText("Newer server name")).not.toBeInTheDocument();
    mounted.rerender(wrap(unavailable));
    expect(nameField()).toHaveValue("My unsaved name");
    fireEvent.click(screen.getByRole("button", { name: en.catalog.form.saveChanges }));
    await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({
      method: "PUT", url: productPath, body: expect.objectContaining({ version: JEANS.version, name_en: "My unsaved name" }),
    })));
    expect(calls.filter((call) => call.url === productPath && call.method === "GET")).toHaveLength(0);
  });

  it("uses the refreshed product and version if no edits have started", async () => {
    server();
    const first = await open();
    const latest = { ...JEANS, name_en: "Newer server name", version: 9 };
    server(owner, () => reply(200, latest));
    const refreshed = await open();
    const calls = catalogApi(() => reply(200, latest));
    const mounted = render(wrap(first));

    mounted.rerender(wrap(refreshed));
    expect(nameField()).toHaveValue(latest.name_en);
    fireEvent.click(screen.getByRole("button", { name: en.catalog.form.saveChanges }));
    await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({
      method: "PUT", url: productPath, body: expect.objectContaining({ version: latest.version, name_en: latest.name_en }),
    })));
    expect(calls.filter((call) => call.url === productPath && call.method === "GET")).toHaveLength(0);
  });

  it("loads fresh edit data when the router remounts a previously shown payload", async () => {
    server();
    const cached = await open();
    const latest = { ...JEANS, name_en: "Product after returning to edit", version: 9 };
    const calls = catalogApi(() => reply(200, latest));
    const first = render(wrap(cached));
    expect(nameField()).toHaveValue(JEANS.name_en);
    expect(calls.filter((call) => call.url === productPath && call.method === "GET")).toHaveLength(0);
    first.unmount();

    render(wrap(cached));
    expect(screen.queryByLabelText(en.catalog.form.nameEn)).not.toBeInTheDocument();
    expect(await screen.findByLabelText(en.catalog.form.nameEn)).toHaveValue(latest.name_en);
    expect(calls.filter((call) => call.url === productPath && call.method === "GET")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: en.catalog.form.saveChanges }));
    await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({
      method: "PUT", url: productPath, body: expect.objectContaining({ version: latest.version, name_en: latest.name_en }),
    })));
  });

  it.each([
    { action: "cancel", edit: true, committed: false },
    { action: "unchanged Done", edit: false, committed: false },
    { action: "changed Done", edit: true, committed: true },
  ])("keeps Variant Details open during refresh and chooses the save version after $action", async ({ action, edit, committed }) => {
    server();
    const first = await open();
    const latest = { ...JEANS, name_en: "Refreshed while details are open", version: 9 };
    server(owner, () => reply(200, latest));
    const refreshed = await open();
    const calls = catalogApi(() => reply(200, latest));
    const mounted = render(wrap(first));
    fireEvent.click(screen.getAllByRole("button", { name: /Details of/ })[0]!);
    const sku = screen.getByLabelText(en.catalog.form.sku);
    const changedSku = "SHEET-ONLY";
    if (edit) fireEvent.change(sku, { target: { value: changedSku } });

    mounted.rerender(wrap(refreshed));
    expect(screen.getByLabelText(en.catalog.form.sku)).toBe(sku);
    if (edit) expect(sku).toHaveValue(changedSku);
    fireEvent.click(screen.getByRole("button", { name: action === "cancel" ? en.ui.close : en.catalog.form.sheet.done }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const baseline = committed ? JEANS : latest;
    expect(nameField()).toHaveValue(baseline.name_en);
    expect(calls.filter((call) => call.url === productPath && call.method === "GET")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: en.catalog.form.saveChanges }));
    await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({
      method: "PUT", url: productPath, body: expect.objectContaining({
        version: baseline.version, name_en: baseline.name_en,
        variants: expect.arrayContaining([expect.objectContaining({ id: "v-30", sku: committed ? changedSku : "JN-SLIM-30-BLUE" })]),
      }),
    })));
  });

  it("does not ask for edit data for catalog viewers", async () => {
    const staff = catalogStaff();
    const fetch = server(staff);
    const html = renderToString(wrap(await open(), staff));
    expect(html).toContain(en.catalog.notAllowed.title);
    expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(["/api/v1/me"]);
  });

  it("rejects malformed edit options and retains the original not-found fallback", async () => {
    const fetch = server(owner, () => reply(200, { ...JEANS, options: [{ ...JEANS.options[0], values: null }] }));
    const element = await open();
    expect(renderToString(wrap(element))).not.toContain(`value="${JEANS.name_en}"`);
    expect(fetch).toHaveBeenLastCalledWith(expect.stringContaining(productPath), expect.anything());
    const calls = catalogApi(() => apiError(404, "not_found"));
    render(wrap(element));
    expect(await screen.findByText(en.catalog.notFound.title)).toBeInTheDocument();
    expect(calls.filter((call) => call.url === productPath && call.method === "GET")).toHaveLength(1);
  });

  it("does not use the server seed in a different mounted store scope", async () => {
    server();
    const element = await open();
    const restricted = catalogOwner({ all_stores: false, stores: [owner.stores[0]!] });
    const calls = catalogApi(() => apiError(403, "forbidden"));
    render(wrap(element, restricted));

    expect(screen.queryByLabelText(en.catalog.form.nameEn)).not.toBeInTheDocument();
    expect(await screen.findByText(en.catalog.notAllowed.title)).toBeInTheDocument();
    expect(calls.filter((call) => call.url === productPath && call.method === "GET")).toHaveLength(1);
  });

  it("lets a pristine form retry the browser fallback and re-read on another unusable seed", async () => {
    server(owner, () => reply(503));
    const first = await open();
    const refreshed = await open();
    let reads = 0;
    const clientName = "Product from a subsequent browser read";
    catalogApi(() => ++reads === 1 ? reply(503) : reply(200, { ...JEANS, name_en: reads === 2 ? JEANS.name_en : clientName }));
    const mounted = render(wrap(first));

    expect(await screen.findByText(en.catalog.productLoadError.title)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.ui.retry }));
    expect(await screen.findByLabelText(en.catalog.form.nameEn)).toHaveValue(JEANS.name_en);
    mounted.rerender(wrap(refreshed));
    expect(screen.getByText(en.ui.loading)).toHaveAttribute("role", "status");
    expect(await screen.findByLabelText(en.catalog.form.nameEn)).toHaveValue(clientName);
    expect(reads).toBe(3);
  });
});
