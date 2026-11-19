import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProductDetail } from "@/app/[locale]/(shell)/more/catalog/[productId]/ProductDetail";

import { JEANS, catalogApi, catalogOwner, catalogStaff } from "../helpers/catalog";
import type { Call } from "../helpers/fetch";
import { apiError, networkFailure, reply } from "../helpers/fetch";
import { resetNavigation } from "../helpers/navigation";
import { renderMe } from "../helpers/shell";
import { ar } from "../utils";

vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);

beforeEach(() => resetNavigation("/more/catalog/p-jeans"));
afterEach(() => vi.unstubAllGlobals());

const ADJUST_URL = "/api/v1/catalog/variants/v-32/adjustments";

const movement = (over: Record<string, unknown> = {}) => ({
  id: "m-new",
  at: "2026-11-12T12:05:00Z",
  reason: "received",
  quantity: 6,
  counted_quantity: null,
  on_hand_after: 8,
  actor_type: "user",
  actor_name: "Dana Demo",
  note: null,
  source: "manual",
  ...over,
});

const recorded = (over: Record<string, unknown> = {}, balance = { on_hand: 8, allocated: 1, available: 7, version: 2 }) => reply(201, { movement: movement(over), balance });

const stockError = (code: "stock_changed" | "not_enough_stock", balance: Record<string, number>) =>
  reply(409, { error: { code, message: code, fields: {}, balance } });

/** Serves the product; adjustments go to `adjust`. */
function serve(adjust: (call: Call) => Response | Promise<Response> = () => recorded()) {
  return catalogApi((call) => {
    if (call.method === "GET" && call.url === "/api/v1/catalog/products/p-jeans") return reply(200, JEANS);
    if (call.method === "POST" && call.url.endsWith("/adjustments")) return adjust(call);
    return reply(404);
  });
}

const adjustments = (calls: Call[]) => calls.filter((call) => call.method === "POST" && call.url.endsWith("/adjustments"));

async function openSheet(locale: "en" | "ar" = "en", variant = "32 · Blue") {
  const me = locale === "ar" ? catalogOwner({ user: { ...catalogOwner().user, locale: "ar" } }) : catalogOwner();
  renderMe(<ProductDetail productId="p-jeans" />, me, locale);
  await screen.findByRole("table");
  fireEvent.click(screen.getByRole("button", { name: new RegExp(variant) }));
  return screen.getByRole("dialog", { name: locale === "ar" ? ar.catalog.adjust.title : "Adjust stock" });
}

const pick = (sheet: HTMLElement, group: string, name: string) => fireEvent.click(within(within(sheet).getByRole("radiogroup", { name: group })).getByRole("radio", { name }));
const typeQuantity = (sheet: HTMLElement, value: string, label = "Quantity") => fireEvent.change(within(sheet).getByLabelText(label), { target: { value } });
const save = (sheet: HTMLElement) => fireEvent.click(within(sheet).getByRole("button", { name: "Save adjustment" }));
const numbers = (sheet: HTMLElement) => within(sheet).getByRole("group", { name: "Stock numbers" }).textContent;

describe("adjust stock sheet (screen 14, designs 146 to 152)", () => {
  it("opens from a variant row with that variant chosen and its numbers", async () => {
    serve();
    const sheet = await openSheet();
    expect(within(sheet).getByRole("combobox", { name: "Variant" })).toHaveValue("v-32");
    expect(numbers(sheet)).toBe("On hand now2Reserved1Available1");
    expect(within(sheet).getByRole("link", { name: /History/ })).toHaveAttribute("href", "/more/catalog/p-jeans/variants/v-32/history");
  });

  it("opens from the footer button too, and staff get neither", async () => {
    serve();
    renderMe(<ProductDetail productId="p-jeans" />, catalogOwner());
    await screen.findByRole("table");
    expect(screen.getByText("Tap a variant to adjust its stock or open its history.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Adjust stock" }));
    expect(within(screen.getByRole("dialog", { name: "Adjust stock" })).getByRole("combobox", { name: "Variant" })).toHaveValue("v-30");
  });

  it("gives staff no way to adjust stock", async () => {
    serve();
    renderMe(<ProductDetail productId="p-jeans" />, catalogStaff());
    await screen.findByRole("table");
    expect(screen.queryByRole("button", { name: /32 · Blue/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Adjust stock" })).not.toBeInTheDocument();
  });

  it("offers the reasons of each mode: Add, Remove and Set count", async () => {
    serve();
    const sheet = await openSheet();
    const modes = within(sheet).getByRole("radiogroup", { name: "Kind of change" });
    expect(within(modes).getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["Add", "Remove", "Set count"]);
    const reasons = () => within(within(sheet).getByRole("radiogroup", { name: "Reason" })).getAllByRole("radio").map((radio) => radio.textContent);
    expect(reasons()).toEqual(["Received", "Found", "Opening stock", "Other"]);
    pick(sheet, "Kind of change", "Remove");
    expect(reasons()).toEqual(["Damaged", "Lost", "Other"]);
    pick(sheet, "Kind of change", "Set count");
    expect(within(sheet).queryByRole("radiogroup", { name: "Reason" })).not.toBeInTheDocument();
    expect(within(sheet).getByLabelText("Counted on the shelf")).toBeInTheDocument();
  });

  it("previews the result, sends the change with the balance version and a key, and says saved only after the server answers", async () => {
    let release: (response: Response) => void = () => {};
    const calls = serve(() => new Promise<Response>((resolve) => (release = resolve)));
    const sheet = await openSheet();
    pick(sheet, "Reason", "Received");
    typeQuantity(sheet, "6");
    expect(within(sheet).getByText("After saving: on hand 8, available 7.")).toBeInTheDocument();
    save(sheet);

    await waitFor(() => expect(adjustments(calls)).toHaveLength(1));
    const call = adjustments(calls)[0]!;
    expect(call.url).toBe(ADJUST_URL);
    expect(call.body).toEqual({ reason: "received", quantity: 6, balance_version: 1 });
    expect(call.headers["Idempotency-Key"]).toEqual(expect.any(String));
    expect(within(sheet).getByRole("button", { name: /Saving/ })).toBeDisabled();
    expect(screen.queryByText(/^Saved\./)).not.toBeInTheDocument();

    release(recorded());
    expect(await screen.findByText("Saved. 32 · Blue: on hand 8, available 7.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const row = screen.getByRole("row", { name: /32 · Blue/ });
    expect(within(row).getAllByRole("cell").slice(1).map((cell) => cell.textContent)).toEqual(["8", "1", "7"]);
  });

  it("asks for a note for Other and sends direction in under Add", async () => {
    const calls = serve(() => recorded({ reason: "other", note: "gift back" }));
    const sheet = await openSheet();
    pick(sheet, "Reason", "Other");
    typeQuantity(sheet, "1");
    expect(within(sheet).getByLabelText("Note (required)")).toBeInTheDocument();
    save(sheet);
    expect(await within(sheet).findByText("Add a note saying why.")).toBeInTheDocument();
    expect(adjustments(calls)).toHaveLength(0);

    fireEvent.change(within(sheet).getByLabelText("Note (required)"), { target: { value: "gift back" } });
    save(sheet);
    await waitFor(() => expect(adjustments(calls)).toHaveLength(1));
    expect(adjustments(calls)[0]!.body).toEqual({ reason: "other", quantity: 1, direction: "in", note: "gift back", balance_version: 1 });
  });

  it("sends Other with direction out under Remove; the person never types a minus sign", async () => {
    const calls = serve(() => recorded({ reason: "other", quantity: -1 }, { on_hand: 1, allocated: 1, available: 0, version: 2 }));
    const sheet = await openSheet();
    pick(sheet, "Kind of change", "Remove");
    pick(sheet, "Reason", "Other");
    typeQuantity(sheet, "1");
    fireEvent.change(within(sheet).getByLabelText("Note (required)"), { target: { value: "sample for a photo" } });
    expect(within(sheet).getByText("After saving: on hand 1, available 0.")).toBeInTheDocument();
    save(sheet);
    await waitFor(() => expect(adjustments(calls)).toHaveLength(1));
    expect(adjustments(calls)[0]!.body).toEqual({ reason: "other", quantity: 1, direction: "out", note: "sample for a photo", balance_version: 1 });
  });

  it("records a count with the number counted and previews the difference", async () => {
    const calls = serve(() => recorded({ reason: "count_correction", quantity: 3, counted_quantity: 5 }, { on_hand: 5, allocated: 1, available: 4, version: 2 }));
    const sheet = await openSheet();
    pick(sheet, "Kind of change", "Set count");
    typeQuantity(sheet, "5", "Counted on the shelf");
    expect(within(sheet).getByText("Difference +3. After saving: on hand 5, available 4.")).toBeInTheDocument();
    save(sheet);
    await waitFor(() => expect(adjustments(calls)).toHaveLength(1));
    expect(adjustments(calls)[0]!.body).toEqual({ reason: "count_correction", counted_quantity: 5, balance_version: 1 });
    expect(await screen.findByText("Saved. 32 · Blue: on hand 5, available 4.")).toBeInTheDocument();
  });

  it("accepts Arabic-Indic digits and the − and + buttons of the stepper", async () => {
    const calls = serve();
    const sheet = await openSheet("ar");
    expect(within(sheet).getByRole("combobox", { name: ar.catalog.adjust.variant })).toHaveValue("v-32");
    pick(sheet, ar.catalog.adjust.reasonGroup, ar.catalog.reasons.received);
    typeQuantity(sheet, "٦", ar.catalog.adjust.quantity);
    fireEvent.click(within(sheet).getByRole("button", { name: ar.ui.increase }));
    fireEvent.click(within(sheet).getByRole("button", { name: ar.ui.increase }));
    fireEvent.click(within(sheet).getByRole("button", { name: ar.ui.decrease }));
    expect(within(sheet).getByLabelText(ar.catalog.adjust.quantity)).toHaveValue("7");
    fireEvent.click(within(sheet).getByRole("button", { name: ar.catalog.adjust.save }));
    await waitFor(() => expect(adjustments(calls)).toHaveLength(1));
    expect(adjustments(calls)[0]!.body).toMatchObject({ reason: "received", quantity: 7 });
  });

  it("checks the quantity before sending", async () => {
    const calls = serve();
    const sheet = await openSheet();
    save(sheet);
    expect(await within(sheet).findByText("Choose a reason.")).toBeInTheDocument();
    pick(sheet, "Reason", "Found");
    typeQuantity(sheet, "0");
    save(sheet);
    expect(await within(sheet).findByText("Enter a whole number from 1 to 1,000,000.")).toBeInTheDocument();
    typeQuantity(sheet, "2.5");
    save(sheet);
    expect(within(sheet).getByText("Enter a whole number from 1 to 1,000,000.")).toBeInTheDocument();
    expect(adjustments(calls)).toHaveLength(0);
  });

  it("says the most that can be removed before sending (not_enough_stock, design 150)", async () => {
    const calls = serve();
    const sheet = await openSheet();
    pick(sheet, "Kind of change", "Remove");
    pick(sheet, "Reason", "Damaged");
    typeQuantity(sheet, "2");
    save(sheet);
    expect(await within(sheet).findByText("You can remove at most 1: 1 of the 2 on hand is reserved.")).toBeInTheDocument();
    expect(adjustments(calls)).toHaveLength(0);
  });

  it("shows the server's not_enough_stock with the numbers it sent", async () => {
    serve(() => stockError("not_enough_stock", { on_hand: 1, allocated: 0, available: 1, version: 3 }));
    const sheet = await openSheet();
    pick(sheet, "Kind of change", "Remove");
    pick(sheet, "Reason", "Lost");
    typeQuantity(sheet, "1");
    // The phone thought 1 could go (available 1); the server knows better.
    save(sheet);
    expect(await within(sheet).findByText(/You can remove at most|There isn't enough stock/)).toBeInTheDocument();
    expect(numbers(sheet)).toBe("On hand now1Reserved0Available1");
    expect(screen.queryByText(/^Saved\./)).not.toBeInTheDocument();
  });

  it("shows the new numbers after stock_changed, keeps what was typed and saves again with the new version (design 149)", async () => {
    let first = true;
    const calls = serve(() => {
      if (first) {
        first = false;
        return stockError("stock_changed", { on_hand: 7, allocated: 1, available: 6, version: 2 });
      }
      return recorded({}, { on_hand: 13, allocated: 1, available: 12, version: 3 });
    });
    const sheet = await openSheet();
    pick(sheet, "Reason", "Received");
    typeQuantity(sheet, "6");
    save(sheet);
    expect(await within(sheet).findByText(/Not saved\. The stock changed while you had this open/)).toBeInTheDocument();
    expect(numbers(sheet)).toBe("On hand now7Reserved1Available6");
    expect(within(sheet).getByText("After saving: on hand 13, available 12.")).toBeInTheDocument();
    expect(within(sheet).getByLabelText("Quantity")).toHaveValue("6");
    expect(within(sheet).getByRole("radio", { name: "Received" })).toHaveAttribute("aria-checked", "true");

    save(sheet);
    await waitFor(() => expect(adjustments(calls)).toHaveLength(2));
    expect(adjustments(calls)[1]!.body).toMatchObject({ balance_version: 2 });
    expect(await screen.findByText("Saved. 32 · Blue: on hand 13, available 12.")).toBeInTheDocument();
  });

  it("reuses the sheet's key when a save gets no answer, and a new sheet gets a new key (design 152)", async () => {
    let fail = true;
    const calls = serve(() => (fail ? networkFailure() : recorded()));
    const sheet = await openSheet();
    pick(sheet, "Reason", "Received");
    typeQuantity(sheet, "6");
    save(sheet);
    expect(await within(sheet).findByText(/Didn’t go through\. Nothing was saved/)).toBeInTheDocument();
    expect(screen.queryByText(/^Saved\./)).not.toBeInTheDocument();
    fail = false;
    fireEvent.click(within(sheet).getByRole("button", { name: /Try again/ }));
    await waitFor(() => expect(adjustments(calls)).toHaveLength(2));
    const [one, two] = adjustments(calls);
    expect(two!.headers["Idempotency-Key"]).toBe(one!.headers["Idempotency-Key"]);
    expect(await screen.findByText(/^Saved\./)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /30 · Blue/ }));
    const next = screen.getByRole("dialog", { name: "Adjust stock" });
    pick(next, "Reason", "Found");
    typeQuantity(next, "1");
    save(next);
    await waitFor(() => expect(adjustments(calls)).toHaveLength(3));
    expect(adjustments(calls)[2]!.headers["Idempotency-Key"]).not.toBe(one!.headers["Idempotency-Key"]);
    expect(adjustments(calls)[2]!.url).toBe("/api/v1/catalog/variants/v-30/adjustments");
  });

  it("treats try_again like no answer: nothing saved, same key on retry", async () => {
    serve(() => apiError(503, "try_again"));
    const sheet = await openSheet();
    pick(sheet, "Reason", "Received");
    typeQuantity(sheet, "6");
    save(sheet);
    expect(await within(sheet).findByText(/Didn’t go through\. Nothing was saved/)).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: /Try again/ })).toBeInTheDocument();
  });

  it("hides Delete product once stock has been recorded", async () => {
    catalogApi((call) => {
      if (call.method === "GET") return reply(200, { ...JEANS, has_history: false, variants: JEANS.variants.map((v) => ({ ...v, has_history: false })) });
      return recorded();
    });
    renderMe(<ProductDetail productId="p-jeans" />, catalogOwner());
    await screen.findByRole("table");
    expect(screen.getByRole("button", { name: /Delete product/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /32 · Blue/ }));
    const sheet = screen.getByRole("dialog", { name: "Adjust stock" });
    pick(sheet, "Reason", "Received");
    typeQuantity(sheet, "6");
    save(sheet);
    expect(await screen.findByText(/^Saved\./)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Delete product/ })).not.toBeInTheDocument();
  });
});
