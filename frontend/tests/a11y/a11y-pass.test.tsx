import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createTranslator } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ResetForm } from "@/app/[locale]/(auth)/reset/ResetForm";
import { SignInForm } from "@/app/[locale]/(auth)/sign-in/SignInForm";
import { CatalogList } from "@/app/[locale]/(shell)/more/catalog/CatalogList";
import { NewProduct } from "@/app/[locale]/(shell)/more/catalog/ProductForm";
import { ProductDetail } from "@/app/[locale]/(shell)/more/catalog/[productId]/ProductDetail";
import { StockHistory } from "@/app/[locale]/(shell)/more/catalog/[productId]/variants/[variantId]/history/StockHistory";
import { ImportScreen } from "@/app/[locale]/(shell)/more/catalog/import/ImportScreen";
import { LowStockList } from "@/app/[locale]/(shell)/more/catalog/low-stock/LowStockList";
import { LowStockRow } from "@/app/[locale]/(shell)/sales/LowStockRow";
import { Screen, StatusHeader } from "@/components/Screen";
import { titleFrom } from "@/lib/metadata";

import { catalogApi, catalogOwner, JEANS, page, summary } from "../helpers/catalog";
import { apiError, mockApi, reply } from "../helpers/fetch";
import { resetNavigation } from "../helpers/navigation";
import { visit } from "../helpers/setup-url";
import { renderMe } from "../helpers/shell";
import { installFakeXhr, lastUpload } from "../helpers/stores";
import { ar, en, renderWithIntl } from "../utils";

// Task T087 (accessibility pass): the behaviour the pass added or relies on.

vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);
vi.mock("@/lib/navigate", () => ({ hardNavigate: vi.fn() }));
vi.mock("next-intl/server", () => ({
  getTranslations: async ({ locale }: { locale: "en" | "ar" }) => (key: string) =>
    key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], locale === "ar" ? ar : en),
}));

beforeEach(() => resetNavigation("/sign-in"));
afterEach(() => {
  vi.unstubAllGlobals();
  visit("/");
});

describe("after a submit with errors, focus moves to the first invalid field", () => {
  it("sign-in: an empty form focuses the identifier, then the missing password", async () => {
    renderWithIntl(<SignInForm />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    const identifier = screen.getByLabelText("Phone or email");
    await waitFor(() => expect(identifier).toHaveFocus());
    expect(identifier).toHaveAttribute("aria-invalid", "true");
    expect(identifier).toHaveAccessibleDescription(/./);

    fireEvent.change(identifier, { target: { value: "+96170000111" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getByLabelText("Password")).toHaveFocus());
  });

  it("sign-in: a wrong password focuses the password field, which carries the message", async () => {
    mockApi(() => apiError(401, "invalid_credentials"));
    renderWithIntl(<SignInForm />);
    fireEvent.change(screen.getByLabelText("Phone or email"), { target: { value: "+96170000111" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    const password = screen.getByLabelText("Password");
    await waitFor(() => expect(password).toHaveFocus());
    expect(password).toHaveAccessibleDescription(/Wrong phone, email or password/);
  });

  it("reset request: a bad email focuses the email field", async () => {
    visit("/en/reset");
    renderWithIntl(<ResetForm />);
    const email = await screen.findByLabelText("Email");
    fireEvent.change(email, { target: { value: "not-an-email" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    await waitFor(() => expect(email).toHaveFocus());
    expect(email).toHaveAttribute("aria-invalid", "true");
  });
});

describe("page structure", () => {
  it("a screen is the main landmark", () => {
    render(
      <Screen>
        <p>body</p>
      </Screen>,
    );
    expect(screen.getByRole("main")).toHaveTextContent("body");
  });

  it("a status heading is a sub-heading under an app bar, and the page heading only when asked", () => {
    const { rerender } = render(<StatusHeader tone="accent" icon="check" title="Done" text="All set." />);
    expect(screen.getByRole("heading", { name: "Done", level: 2 })).toBeInTheDocument();
    rerender(<StatusHeader tone="accent" icon="check" title="Done" text="All set." level={1} />);
    expect(screen.getByRole("heading", { name: "Done", level: 1 })).toBeInTheDocument();
  });

  it("each page names the browser tab after its screen, in the page language", async () => {
    const generate = titleFrom("staff.title");
    expect(await generate({ params: Promise.resolve({ locale: "en" }) })).toEqual({ title: en.staff.title });
    expect(await generate({ params: Promise.resolve({ locale: "ar" }) })).toEqual({ title: ar.staff.title });
    expect(await generate({ params: Promise.resolve({ locale: "fr" }) })).toEqual({});
  });
});

// T106: semantic assertions here; real Tab traversal/layout are browser checks.
describe.each(["en", "ar"] as const)("M1 accessibility in %s", (locale) => {
  const t = createTranslator({ locale, messages: locale === "ar" ? ar : en });
  const owner = catalogOwner();
  const me = { ...owner, user: { ...owner.user, locale } };

  it("names the catalog search and exposes one Tab stop in the stock radiogroup", async () => {
    catalogApi(() => reply(200, page([summary({ id: JEANS.id })])));
    renderMe(<CatalogList />, me);
    expect(screen.getByRole("searchbox", { name: t("catalog.search") })).toBeInTheDocument();
    const list = await screen.findByRole("list", { name: t("catalog.title") });
    expect(within(list).getByText(t("catalog.stock.low"), { exact: true })).toBeVisible();
    const filter = within(screen.getByRole("radiogroup", { name: t("catalog.stockFilter") }));
    const checked = filter.getByRole("radio", { checked: true });
    expect(filter.getAllByRole("radio").filter((radio) => radio.tabIndex === 0)).toEqual([checked]);
  });

  it("labels the stock columns and restores focus from the named adjust dialog", async () => {
    catalogApi(() => reply(200, JEANS));
    renderMe(<ProductDetail productId={JEANS.id} />, me);
    const table = within(await screen.findByRole("table"));
    expect(table.getByRole("columnheader", { name: t("catalog.stock.reserved") })).toBeInTheDocument();
    for (const status of ["low", "out"] as const) expect(table.getByText(t(`catalog.stock.${status}`), { exact: true })).toBeVisible();
    const opener = screen.getByRole("button", { name: t("catalog.detail.adjust") });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: t("catalog.adjust.title") });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveFocus();
    expect(within(dialog).getByRole("combobox", { name: t("catalog.adjust.variant") })).toBeInTheDocument();
    expect(within(dialog).getByLabelText(t("catalog.adjust.quantity"))).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(dialog).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("sets language-specific input direction and describes an invalid product name", async () => {
    catalogApi(() => reply(404));
    renderMe(<NewProduct />, me);
    const nameEn = await screen.findByRole("textbox", { name: t("catalog.form.nameEn") });
    expect(nameEn).toHaveAttribute("dir", "ltr");
    expect(screen.getByRole("textbox", { name: t("catalog.form.nameAr") })).toHaveAttribute("dir", "rtl");
    fireEvent.click(screen.getByRole("button", { name: t("catalog.form.save") }));
    expect(nameEn).toHaveAttribute("aria-invalid", "true");
    expect(nameEn).toHaveAccessibleDescription(/\S/);
  });

  it("labels stock history and isolates the SKU from surrounding bidi text", async () => {
    catalogApi(({ url }) => url.includes("/movements") ? reply(200, { items: [], next_cursor: null }) : reply(200, JEANS));
    renderMe(<StockHistory productId={JEANS.id} variantId="v-32" />, me);
    expect(screen.getByRole("heading", { name: t("catalog.history.title"), level: 1 })).toBeInTheDocument();
    expect(await screen.findByText("JN-SLIM-32-BLUE", { exact: true })).toHaveAttribute("dir", "ltr");
  });

  it("names the Low stock list and its start-tab shortcut without relying on colour", async () => {
    const items = [{ variant_id: "v-32", product_id: JEANS.id, product_name_en: JEANS.name_en, product_name_ar: JEANS.name_ar, sku: "JN-SLIM-32-BLUE", option_values: ["32", "Blue"], main_photo_id: null, on_hand: 1, allocated: 0, available: 1, level: 2, stock_state: "low" }];
    catalogApi(() => reply(200, { items, next_cursor: null, total: items.length }));
    renderMe(<><LowStockRow /><LowStockList /></>, me);
    const shortcut = within(await screen.findByRole("region", { name: t("catalog.lowStock.row.label") })).getByRole("link", { name: new RegExp(t("catalog.lowStock.row.count", { count: 1 })) });
    expect(shortcut).toHaveAttribute("href", "/more/catalog/low-stock");
    const list = within(await screen.findByRole("list", { name: t("catalog.lowStock.title") }));
    expect(list.getByText(t("catalog.stock.low"), { exact: true })).toBeVisible();
    expect(list.getByRole("group", { name: t("catalog.lowStock.figures") })).toBeInTheDocument();
  });

  // T106 state matrix: the loading, empty and error states of the two lists, localized, with one live
  // announcement each and a named Retry.
  it("Low stock: loading is a named status, empty is a heading, a failed load is an alert with a working Retry", async () => {
    mockApi(() => new Promise<Response>(() => undefined));
    const loading = renderMe(<LowStockList />, me);
    expect(screen.getByRole("status")).toHaveTextContent(t("catalog.lowStock.loading"));
    expect(screen.getByRole("heading", { level: 1, name: t("catalog.lowStock.title") })).toBeInTheDocument();
    loading.unmount();

    catalogApi(() => reply(200, { items: [], next_cursor: null, total: 0 }));
    const empty = renderMe(<LowStockList />, me);
    expect(await screen.findByRole("heading", { name: t("catalog.lowStock.empty.title") })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    empty.unmount();

    let fail = true;
    const items = [{ variant_id: "v-32", product_id: JEANS.id, product_name_en: JEANS.name_en, product_name_ar: JEANS.name_ar, sku: "JN-SLIM-32-BLUE", option_values: ["32", "Blue"], main_photo_id: null, on_hand: 1, allocated: 0, available: 1, level: 2, stock_state: "low" }];
    catalogApi(() => (fail ? apiError(503, "unavailable") : reply(200, { items, next_cursor: null, total: 1 })));
    renderMe(<LowStockList />, me);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(t("catalog.lowStock.loadError.title"));
    expect(alert).toHaveTextContent(t("catalog.lowStock.loadError.text"));
    const retry = screen.getByRole("button", { name: t("ui.retry") });
    fail = false;
    fireEvent.click(retry);
    expect(await screen.findByRole("list", { name: t("catalog.lowStock.title") })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("Stock history: loading is a named status, empty is a heading, a failed load is an alert with a working Retry", async () => {
    mockApi(() => new Promise<Response>(() => undefined));
    const loading = renderMe(<StockHistory productId={JEANS.id} variantId="v-32" />, me);
    expect(screen.getByRole("status")).toHaveTextContent(t("catalog.history.loading"));
    expect(screen.getByRole("heading", { level: 1, name: t("catalog.history.title") })).toBeInTheDocument();
    loading.unmount();

    catalogApi(({ url }) => (url.includes("/movements") ? reply(200, { items: [], next_cursor: null }) : reply(200, JEANS)));
    const empty = renderMe(<StockHistory productId={JEANS.id} variantId="v-32" />, me);
    expect(await screen.findByRole("heading", { name: t("catalog.history.empty.title") })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    empty.unmount();

    let fail = true;
    catalogApi(({ url }) => (fail ? apiError(503, "unavailable") : url.includes("/movements") ? reply(200, { items: [], next_cursor: null }) : reply(200, JEANS)));
    renderMe(<StockHistory productId={JEANS.id} variantId="v-32" />, me);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(t("catalog.history.loadError.title"));
    expect(alert).toHaveTextContent(t("catalog.history.loadError.text"));
    const retry = screen.getByRole("button", { name: t("ui.retry") });
    fail = false;
    fireEvent.click(retry);
    expect(await screen.findByRole("heading", { name: t("catalog.history.empty.title") })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("names CSV upload progress and announces row errors before allowing import", async () => {
    installFakeXhr();
    renderMe(<ImportScreen />, me);
    expect(screen.getByLabelText(t("catalog.import.choose"))).toBeEnabled();
    fireEvent.change(screen.getByTestId("csv-input"), { target: { files: [new File(["price"], "catalog.csv", { type: "text/csv" })] } });
    lastUpload().progress(1, 2);
    expect(await screen.findByRole("progressbar", { name: t("catalog.import.progress") })).toHaveAttribute("aria-valuenow", "50");
    lastUpload().respond(200, {
      id: "batch-a11y", status: "previewed", file_name: "catalog.csv", row_count: 1, products: 0, variants: 0, opening_units: 0,
      errors: [{ row: 2, column: "price", code: "required" }], expires_at: "2026-11-19T07:41:00Z", committed_at: null,
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(t("catalog.import.rowsToFix", { count: 1 }));
    const problems = await screen.findByRole("list", { name: `${t("catalog.import.problems")} · 1` });
    expect(within(problems).getByRole("listitem")).toHaveTextContent(t("catalog.import.row", { row: 2 }));
    expect(screen.getByRole("button", { name: t("catalog.import.importBlocked", { count: 1 }) })).toBeDisabled();
  });
});
