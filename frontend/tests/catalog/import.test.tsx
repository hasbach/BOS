import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ImportScreen } from "@/app/[locale]/(shell)/more/catalog/import/ImportScreen";
import type { ImportBatch } from "@/lib/imports";
import { MeContext, MeSetterContext } from "@/lib/session";
import type { Me } from "@/lib/types";

import en from "../../messages/en.json";

import { catalogOwner, catalogStaff } from "../helpers/catalog";
import type { Call } from "../helpers/fetch";
import { mockApi, networkFailure, reply } from "../helpers/fetch";
import { resetNavigation } from "../helpers/navigation";
import { renderMe } from "../helpers/shell";
import { FakeXhr, installFakeXhr, lastUpload } from "../helpers/stores";

vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);

beforeEach(() => {
  resetNavigation("/more/catalog/import");
  installFakeXhr();
});
afterEach(() => vi.unstubAllGlobals());

const batch = (over: Partial<ImportBatch> = {}): ImportBatch => ({
  id: "ib-1",
  status: "previewed",
  file_name: "catalog-nov.csv",
  row_count: 40,
  products: 12,
  variants: 40,
  opening_units: 312,
  errors: [],
  expires_at: "2026-11-19T07:41:00Z",
  committed_at: null,
  ...over,
});

const ERRORS: ImportBatch["errors"] = [
  { row: 7, column: "sku", code: "duplicate_in_file" },
  { row: 12, column: "price", code: "required" },
  { row: 19, column: "opening_quantity", code: "negative" },
];

const csv = (name = "catalog-nov.csv", size = 48 * 1024) => {
  const file = new File(["product_code,name_en"], name, { type: "text/csv" });
  Object.defineProperty(file, "size", { value: size });
  return file;
};

const choose = (file: File = csv()) => fireEvent.change(screen.getByTestId("csv-input"), { target: { files: [file] } });
const confirms = (calls: Call[]) => calls.filter((call) => call.method === "POST" && call.url === "/api/v1/catalog/imports/ib-1/confirm");
const open = (locale: "en" | "ar" = "en") =>
  renderMe(<ImportScreen />, catalogOwner({ user: { ...catalogOwner().user, locale } }), locale);

/** Uploads a file and answers it with `answer` (status and body). */
async function upload(status: number, body: unknown, file?: File) {
  choose(file);
  await waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
  lastUpload().respond(status, body);
}

describe("CSV import (screens 176 to 183)", () => {
  it("explains the steps and limits, and links the template download (screen 176)", () => {
    const calls = mockApi(() => reply(404));
    open();
    expect(screen.getByRole("heading", { level: 1, name: "Import products" })).toBeInTheDocument();
    expect(screen.getByText("1. Download the template")).toBeInTheDocument();
    expect(screen.getByText("2. Fill one row per variant")).toBeInTheDocument();
    expect(screen.getByText("3. Upload and check the preview")).toBeInTheDocument();
    const template = screen.getByRole("link", { name: /Download template/ });
    expect(template).toHaveAttribute("href", "/api/v1/catalog/imports/template");
    expect(template).toHaveAttribute("download");
    expect(screen.getByText(/up to 2,000 rows and 2 MB/)).toBeInTheDocument();
    expect(screen.getByText(/Photos can’t be imported/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Choose CSV file/)).toBeEnabled();
    expect(calls).toHaveLength(0);
  });

  it("uploads the file with progress, saying nothing is saved yet (screen 177)", async () => {
    mockApi(() => reply(404));
    open();
    choose();
    await waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
    const xhr = lastUpload();
    expect(xhr).toMatchObject({ method: "POST", url: "/api/v1/catalog/imports" });
    expect(xhr.headers["X-BOS-CSRF"]).toBe("1");
    expect((xhr.form?.get("file") as File).name).toBe("catalog-nov.csv");

    xhr.progress(5, 10);
    expect(await screen.findByRole("progressbar", { name: "Upload progress" })).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByRole("status")).toHaveTextContent("Checking every row… Nothing is saved yet.");
    expect(screen.getByRole("button", { name: /Checking…/ })).toBeDisabled();
    expect(screen.getByText("catalog-nov.csv")).toBeInTheDocument();
  });

  it("shows a file-level refusal as one clear message with the extra columns (screen 178)", async () => {
    mockApi(() => reply(404));
    open();
    await upload(400, { error: { code: "unknown_columns", message: "x", columns: ["photo_url", "image"] } });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The file has columns that aren't in the template. Photos can't be imported.");
    expect(alert).toHaveTextContent("Columns: photo_url, image");
    expect(screen.getByText(/not checked/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Choose another file/)).toBeEnabled();
    expect(screen.getByRole("link", { name: /Download template/ })).toBeInTheDocument();
  });

  it("refuses a file over 2 MB before sending it", async () => {
    mockApi(() => reply(404));
    open();
    choose(csv("big.csv", 3 * 1024 * 1024));
    expect(await screen.findByRole("alert")).toHaveTextContent("The file is too large.");
    expect(FakeXhr.instances).toHaveLength(0);
  });

  it("lists every row error with its row, column and a translated reason, and offers no import (screen 179)", async () => {
    const calls = mockApi(() => reply(404));
    open();
    await upload(201, batch({ status: "failed", errors: ERRORS, products: 0, variants: 0, opening_units: 0 }));
    expect(await screen.findByRole("alert")).toHaveTextContent("3 rows need fixing. Nothing can be imported until the file has no errors. Nothing was saved.");
    const list = screen.getByRole("list", { name: /Problems/ });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText("Row 7")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("sku")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Repeated in this file")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Required")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("opening_quantity")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("Can't be negative")).toBeInTheDocument();
    expect(screen.getByText(/40 rows/)).toBeInTheDocument();

    const blocked = screen.getByRole("button", { name: "Import — fix 3 rows first" });
    expect(blocked).toBeDisabled();
    fireEvent.click(blocked);
    expect(confirms(calls)).toHaveLength(0);
    expect(screen.getByLabelText(/Upload fixed file/)).toBeEnabled();
  });

  it("counts rows that need fixing, not errors, and shows a whole-row problem", async () => {
    mockApi(() => reply(404));
    open();
    await upload(201, batch({ status: "failed", errors: [{ row: 4, column: "price", code: "required" }, { row: 4, column: "currency", code: "invalid_currency" }, { row: 9, column: null, code: "inconsistent_product" }] }));
    expect(await screen.findByRole("alert")).toHaveTextContent("2 rows need fixing.");
    expect(screen.getByText("Whole row")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import — fix 2 rows first" })).toBeDisabled();
  });

  it("shows the counts, imports on confirm and shows the result only after the server confirms (screens 180 and 181)", async () => {
    let release: (response: Response) => void = () => {};
    const calls = mockApi((call) => (call.method === "POST" ? new Promise<Response>((resolve) => (release = resolve)) : reply(404)));
    open();
    await upload(201, batch());
    expect(await screen.findByText("No errors")).toBeInTheDocument();
    const counts = screen.getByRole("group", { name: "If you import this file" });
    expect(within(counts).getByText("Products").nextSibling).toHaveTextContent("12");
    expect(within(counts).getByText("Variants").nextSibling).toHaveTextContent("40");
    expect(within(counts).getByText("Units of opening stock").nextSibling).toHaveTextContent("312");
    expect(within(counts).getByText("Rows checked").nextSibling).toHaveTextContent("40");
    expect(screen.getByText(/Nothing is saved yet. This preview is kept until 19 Nov 2026/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Import 12 products" }));
    await waitFor(() => expect(confirms(calls)).toHaveLength(1));
    expect(confirms(calls)[0]!.headers["X-BOS-CSRF"]).toBe("1");
    expect(screen.getByRole("button", { name: /Importing…/ })).toBeDisabled();
    expect(screen.queryByText("Imported")).not.toBeInTheDocument();

    release(reply(200, batch({ status: "committed", committed_at: "2026-11-18T08:00:00Z" })));
    expect(await screen.findByRole("heading", { name: "Imported" })).toBeInTheDocument();
    expect(screen.getByText("12 products, 40 variants and 312 units of opening stock are now in your catalog.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Add photos/ })).toHaveAttribute("href", "/more/catalog?no_photo=1");
    expect(screen.getByRole("link", { name: "View catalog" })).toHaveAttribute("href", "/more/catalog");
  });

  it("says nothing was saved and offers the same confirm again when there is no answer", async () => {
    let fail = true;
    const calls = mockApi((call) => (call.method !== "POST" ? reply(404) : fail ? networkFailure() : reply(200, batch({ status: "committed" }))));
    open();
    await upload(201, batch());
    fireEvent.click(await screen.findByRole("button", { name: "Import 12 products" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Nothing was saved");
    expect(screen.queryByRole("heading", { name: "Imported" })).not.toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Import 12 products" }));
    expect(await screen.findByRole("heading", { name: "Imported" })).toBeInTheDocument();
    expect(confirms(calls)).toHaveLength(2);
  });

  it("lists the new conflicts when something changed since the preview (screen 182)", async () => {
    mockApi((call) =>
      call.method === "POST" ? reply(409, { error: { code: "import_conflict", message: "x", errors: [{ row: 7, column: "sku", code: "sku_in_use" }] } }) : reply(404),
    );
    open();
    await upload(201, batch());
    fireEvent.click(await screen.findByRole("button", { name: "Import 12 products" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Nothing was imported. Something changed in your catalog since the preview:");
    const rows = within(screen.getByRole("list", { name: /Problems/ })).getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).getByText("Row 7")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("This SKU is already used")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Import/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Upload the file again/)).toBeEnabled();
  });

  it("says the preview expired and offers to upload again (screen 183)", async () => {
    mockApi((call) => (call.method === "POST" ? reply(410, { error: { code: "import_expired", message: "x" } }) : reply(404)));
    open();
    await upload(201, batch());
    fireEvent.click(await screen.findByRole("button", { name: "Import 12 products" }));
    expect(await screen.findByRole("heading", { name: "This preview has expired" })).toBeInTheDocument();
    expect(screen.getByText(/Nothing was imported/)).toBeInTheDocument();
    const again = screen.getByLabelText(/Upload the file again/);
    fireEvent.click(again);
    // Back at the start, ready for the file again, with the same input whose native chooser is open.
    expect(screen.getByLabelText(/Choose CSV file/)).toBe(again);
    choose();
    await waitFor(() => expect(FakeXhr.instances).toHaveLength(2));
  });

  it("is only for owners and managers", () => {
    const calls = mockApi(() => reply(404));
    renderMe(<ImportScreen />, catalogStaff());
    expect(screen.getByText("Only owners and managers can change products")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Download template/ })).not.toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it("is available in Arabic, with translated reasons", async () => {
    mockApi(() => reply(404));
    open("ar");
    expect(screen.getByRole("heading", { level: 1, name: "استيراد منتجات" })).toBeInTheDocument();
    await upload(201, batch({ status: "failed", errors: ERRORS }));
    expect(await screen.findByText("مكرّر في الملف")).toBeInTheDocument();
    expect(screen.getByText("السطر 7")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "الاستيراد — صحّح 3 أسطر أولاً" })).toBeDisabled();
  });
  it("offers the preview's other file as a secondary chooser, disabled while importing", async () => {
    mockApi((call) => (call.method === "POST" ? new Promise<Response>(() => undefined) : reply(404)));
    open();
    await upload(201, batch());
    const other = await screen.findByLabelText("Choose another file");
    expect(other).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Import 12 products" }));
    await waitFor(() => expect(screen.getByLabelText("Choose another file")).toBeDisabled());
  });
});

describe("CSV chooser before and after hydration", () => {
  const wrap = (ui: ReactElement, me: Me = catalogOwner()) => (
    <NextIntlClientProvider locale="en" messages={en}>
      <MeSetterContext.Provider value={() => undefined}>
        <MeContext.Provider value={me}>{ui}</MeContext.Provider>
      </MeSetterContext.Provider>
    </NextIntlClientProvider>
  );

  /** The server HTML in a container, as the browser has it before the page's scripts run. */
  function serverHtml() {
    const container = document.createElement("div");
    container.innerHTML = renderToString(wrap(<ImportScreen />));
    document.body.appendChild(container);
    return container;
  }

  /** A file the person chose in the native chooser; clearing the value empties it, as in a browser. */
  function chooseNatively(input: HTMLInputElement, file: File) {
    let files: File[] = [file];
    Object.defineProperty(input, "files", { configurable: true, get: () => files });
    Object.defineProperty(input, "value", {
      configurable: true,
      get: () => (files.length ? `C:\\fakepath\\${files[0]!.name}` : ""),
      set: (value: string) => {
        if (value === "") files = [];
      },
    });
  }

  it("renders an enabled, labelled native file input in the server HTML", () => {
    mockApi(() => reply(404));
    const container = serverHtml();
    const input = container.querySelector<HTMLInputElement>('[data-testid="csv-input"]')!;
    expect(input).toBeInstanceOf(HTMLInputElement);
    expect(input.type).toBe("file");
    expect(input.accept).toBe(".csv,text/csv");
    expect(input.disabled).toBe(false);
    expect(input.hidden).toBe(false);
    expect(input.tabIndex).toBe(0);
    expect(input.labels).toHaveLength(1);
    expect(input.labels![0]).toHaveTextContent("Choose CSV file");
    // One keyboard stop: the label drawn as the button is not focusable itself.
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(input.labels![0]!.tabIndex).toBe(-1);
    container.remove();
  });

  it("associates the chooser's label with the input in the rendered screen", () => {
    mockApi(() => reply(404));
    open();
    const input = screen.getByLabelText("Choose CSV file");
    expect(input).toBe(screen.getByTestId("csv-input"));
    expect(input).toHaveAttribute("type", "file");
    expect((input as HTMLInputElement).labels![0]).toHaveAttribute("for", input.id);
  });

  it("uploads a file chosen before hydration exactly once when the screen hydrates", async () => {
    mockApi(() => reply(404));
    const container = serverHtml();
    const input = container.querySelector<HTMLInputElement>('[data-testid="csv-input"]')!;
    chooseNatively(input, csv("early.csv"));
    // The browser's change event fired before React listened.
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(FakeXhr.instances).toHaveLength(0);

    render(wrap(<ImportScreen />), { container, hydrate: true });
    await waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
    expect((lastUpload().form?.get("file") as File).name).toBe("early.csv");
    expect(input.value).toBe("");
    expect(await screen.findByRole("progressbar", { name: "Upload progress" })).toBeInTheDocument();
    // A change event React replays after hydration finds the input already cleared.
    fireEvent.change(input);
    expect(FakeXhr.instances).toHaveLength(1);
    container.remove();
  });

  it("does nothing on hydration when no file was chosen", async () => {
    const calls = mockApi(() => reply(404));
    const container = serverHtml();
    render(wrap(<ImportScreen />), { container, hydrate: true });
    expect(await screen.findByLabelText("Choose CSV file")).toBeEnabled();
    expect(FakeXhr.instances).toHaveLength(0);
    expect(calls).toHaveLength(0);
    container.remove();
  });

  it("uploads again when the same file is chosen after a refusal", async () => {
    mockApi(() => reply(404));
    open();
    const file = csv();
    const input = screen.getByTestId("csv-input") as HTMLInputElement;
    chooseNatively(input, file);
    fireEvent.change(input);
    await waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
    // Cleared, so choosing the same file again is a change the browser reports.
    expect(input.value).toBe("");
    lastUpload().respond(400, { error: { code: "file_not_csv", message: "x" } });
    // The chooser was not shown while checking, so this is a fresh, empty input.
    const again = (await screen.findByLabelText(/Choose another file/)) as HTMLInputElement;
    expect(again.value).toBe("");

    chooseNatively(again, file);
    fireEvent.change(again);
    await waitFor(() => expect(FakeXhr.instances).toHaveLength(2));
    expect((lastUpload().form?.get("file") as File).name).toBe("catalog-nov.csv");
  });

  it("takes the next file from the same, cleared input after an oversize refusal", async () => {
    mockApi(() => reply(404));
    open();
    const input = screen.getByTestId("csv-input") as HTMLInputElement;
    const big = csv("big.csv", 3 * 1024 * 1024);
    chooseNatively(input, big);
    fireEvent.change(input);
    expect(await screen.findByRole("alert")).toHaveTextContent("The file is too large.");
    // Refused before sending, so the chooser stayed the same element; its value was cleared.
    expect(screen.getByLabelText(/Choose another file/)).toBe(input);
    expect(input.value).toBe("");

    chooseNatively(input, csv());
    fireEvent.change(input);
    await waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
    expect((lastUpload().form?.get("file") as File).name).toBe("catalog-nov.csv");
  });
});
