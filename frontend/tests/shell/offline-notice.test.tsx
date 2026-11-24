import { act, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CatalogList } from "@/app/[locale]/(shell)/more/catalog/CatalogList";
import { NewProduct } from "@/app/[locale]/(shell)/more/catalog/ProductForm";
import { ProductDetail } from "@/app/[locale]/(shell)/more/catalog/[productId]/ProductDetail";
import { StockHistory } from "@/app/[locale]/(shell)/more/catalog/[productId]/variants/[variantId]/history/StockHistory";
import { ImportScreen } from "@/app/[locale]/(shell)/more/catalog/import/ImportScreen";
import { LowStockList } from "@/app/[locale]/(shell)/more/catalog/low-stock/LowStockList";
import { AppShell } from "@/components/AppShell";

import { catalogApi, catalogOwner, JEANS, page } from "../helpers/catalog";
import { apiError, reply } from "../helpers/fetch";
import { resetNavigation } from "../helpers/navigation";
import { renderMe } from "../helpers/shell";
import { ar, en } from "../utils";

vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const catalog = "/more/catalog";
const product = `${catalog}/${JEANS.id}`;
const screens = [
  ["Catalog", catalog, () => <CatalogList />],
  ["Product detail", product, () => <ProductDetail productId={JEANS.id} />],
  ["Create product", `${catalog}/new`, () => <NewProduct />],
  ["Stock history", `${product}/variants/v-32/history`, () => <StockHistory productId={JEANS.id} variantId="v-32" />],
  ["Low stock", `${catalog}/low-stock`, () => <LowStockList />],
  ["CSV upload", `${catalog}/import`, () => <ImportScreen />],
] as const;

describe.each(["en", "ar"] as const)("offline notices in %s", (locale) => {
  const { offlineTitle, offlineText } = (locale === "en" ? en : ar).ui;
  const owner = catalogOwner();
  const me = { ...owner, user: { ...owner.user, locale } };

  it.each(screens)("updates one persistent shell status on %s", async (_name, path, content) => {
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    resetNavigation(path);
    catalogApi(({ url }) => reply(200, url === `/api/v1/catalog/products/${JEANS.id}` ? JEANS : page([])));
    const { container } = await act(async () => renderMe(<AppShell>{content()}</AppShell>, me));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(offlineTitle, { exact: true })).not.toBeInTheDocument();
    const liveRegions = () => Array.from(container.querySelectorAll("[aria-live]"));
    expect(liveRegions()).toHaveLength(1);
    const [notice] = liveRegions();
    expect(notice).toHaveAttribute("aria-live", "polite");
    expect(notice).toHaveAttribute("aria-atomic", "true");
    expect(notice).toBeVisible();
    expect(notice).toBeEmptyDOMElement();

    online.mockReturnValue(false);
    act(() => window.dispatchEvent(new Event("offline")));
    const titles = screen.queryAllByText(offlineTitle, { exact: true });
    expect(titles).toHaveLength(1);
    expect(titles[0]).toBeVisible();
    expect(liveRegions()).toHaveLength(1);
    expect(liveRegions()[0]).toBe(notice);
    expect(titles[0]?.closest("[aria-live]")).toBe(notice);
    expect(screen.getAllByText(offlineText, { exact: true })).toHaveLength(1);
    expect(notice).toHaveTextContent(`${offlineTitle} ${offlineText}`);
    expect(within(screen.getByRole("main")).queryByText(offlineTitle, { exact: true })).not.toBeInTheDocument();

    online.mockReturnValue(true);
    act(() => window.dispatchEvent(new Event("online")));
    expect(screen.queryByText(offlineTitle, { exact: true })).not.toBeInTheDocument();
    expect(liveRegions()).toHaveLength(1);
    expect(liveRegions()[0]).toBe(notice);
    expect(notice).toBeEmptyDOMElement();
  });

  it("keeps the screen-local notice when the shell is absent", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    resetNavigation(catalog);
    catalogApi(() => reply(200, page([])));
    await act(async () => {
      renderMe(<CatalogList />, me);
    });

    const notice = within(screen.getByRole("main")).getByText(offlineTitle, { exact: true }).closest("[aria-live]");
    expect(notice).toHaveAttribute("aria-live", "polite");
    expect(notice).toHaveTextContent(offlineText);
  });

  it("keeps the shell notice when the catalog cannot load", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    resetNavigation(catalog);
    catalogApi(() => apiError(503, "service_unavailable"));
    renderMe(
      <AppShell>
        <CatalogList />
      </AppShell>,
      me,
    );

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    const notice = screen.getByText(offlineTitle, { exact: true }).closest("[aria-live]");
    expect(notice).toHaveAttribute("aria-live", "polite");
    expect(notice).toHaveTextContent(offlineTitle);
    expect(notice).toHaveTextContent(offlineText);
  });
});
