import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StockHistory } from "@/app/[locale]/(shell)/more/catalog/[productId]/variants/[variantId]/history/StockHistory";

import { JEANS, catalogApi, catalogOwner, catalogStaff } from "../helpers/catalog";
import type { Call } from "../helpers/fetch";
import { apiError, reply } from "../helpers/fetch";
import { resetNavigation } from "../helpers/navigation";
import { renderMe } from "../helpers/shell";
import { ar } from "../utils";

vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);

beforeEach(() => {
  resetNavigation("/more/catalog/p-jeans/variants/v-32/history");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-12T14:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const mv = (over: Record<string, unknown>) => ({
  id: "m",
  at: "2026-11-12T12:05:00Z",
  reason: "received",
  quantity: 1,
  counted_quantity: null,
  on_hand_after: 1,
  actor_type: "user",
  actor_name: "Karim Demo",
  note: null,
  source: "manual",
  ...over,
});

/** The design's four lines (153): they add up to on hand 2. Times are UTC; Beirut is UTC+2 in November. */
const MOVEMENTS = [
  mv({ id: "m4", at: "2026-11-12T12:05:00Z", reason: "count_correction", quantity: -1, counted_quantity: 2, on_hand_after: 2 }),
  mv({ id: "m3", at: "2026-11-11T15:40:00Z", reason: "damaged", quantity: -1, on_hand_after: 3, note: "torn seam" }),
  mv({ id: "m2", at: "2026-11-11T08:12:00Z", reason: "received", quantity: 2, on_hand_after: 4, actor_name: "Samer Demo", note: "supplier invoice 2231" }),
  mv({ id: "m1", at: "2026-11-10T07:30:00Z", reason: "opening", quantity: 2, on_hand_after: 2, actor_name: "Samer Demo", source: "product_form" }),
];

const HISTORY_URL = "/api/v1/catalog/variants/v-32/movements";

function serve(movements: (call: Call) => Response | Promise<Response>) {
  return catalogApi((call) => {
    if (call.method === "GET" && call.url === "/api/v1/catalog/products/p-jeans") return reply(200, JEANS);
    if (call.method === "GET" && call.url.startsWith(HISTORY_URL)) return movements(call);
    return reply(404);
  });
}

const open = (me = catalogOwner(), locale: "en" | "ar" = "en") => renderMe(<StockHistory productId="p-jeans" variantId="v-32" />, me, locale);

describe("variant stock history (designs 153 to 156)", () => {
  it("lists each change with reason, signed quantity, on hand after, who, Beirut time and note, grouped by day", async () => {
    serve(() => reply(200, { items: MOVEMENTS, next_cursor: null }));
    open();
    expect(await screen.findByText("Damaged")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Stock history" })).toBeInTheDocument();
    expect(screen.getByText("JN-SLIM-32-BLUE")).toBeInTheDocument();
    expect(screen.getByText("Newest first. Times are Beirut time.")).toBeInTheDocument();

    const today = screen.getByRole("region", { name: /^Today/ });
    const count = within(today).getByRole("listitem");
    expect(count).toHaveTextContent("Count correction");
    expect(count).toHaveTextContent("−1");
    expect(count).toHaveTextContent("Counted 2");
    expect(count).toHaveTextContent("On hand after 2 · By Karim Demo · 14:05");

    const yesterday = screen.getByRole("region", { name: /^Yesterday/ });
    const [damaged, received] = within(yesterday).getAllByRole("listitem");
    expect(damaged).toHaveTextContent("−1");
    expect(damaged).toHaveTextContent("Note: torn seam");
    expect(damaged).toHaveTextContent("On hand after 3 · By Karim Demo · 17:40");
    expect(received).toHaveTextContent("+2");
    expect(received).toHaveTextContent("On hand after 4 · By Samer Demo · 10:12");

    const opening = screen.getByText("Opening stock").closest("li")!;
    expect(opening).toHaveTextContent("+2");
    expect(opening).toHaveTextContent("From the product form, when it was created");
    expect(screen.getByText("This is the start of this variant’s history.")).toBeInTheDocument();
  });

  it("says where opening stock came from, and names BOS for system changes", async () => {
    serve(() =>
      reply(200, {
        items: [
          mv({ id: "a", reason: "allocation_consumed", quantity: -1, actor_type: "system", actor_name: null, source: "allocation" }),
          mv({ id: "b", reason: "opening", quantity: 3, source: "manual" }),
          mv({ id: "c", reason: "opening", quantity: 3, source: "import" }),
        ],
        next_cursor: null,
      }),
    );
    open();
    expect(await screen.findByText(/By BOS, automatically/)).toBeInTheDocument();
    expect(screen.getByText("Recorded with Adjust stock")).toBeInTheDocument();
    expect(screen.getByText("From a CSV import")).toBeInTheDocument();
    const consumed = screen.getByText("Sent with an order").closest("li");
    expect(consumed).toHaveTextContent("Reserved stock used");
  });

  it("loads 50 more with the cursor, keeps the lines shown and shows placeholders meanwhile (design 154)", async () => {
    let release: (response: Response) => void = () => {};
    const calls = serve((call) => (call.url.includes("cursor=") ? new Promise<Response>((resolve) => (release = resolve)) : reply(200, { items: MOVEMENTS.slice(0, 2), next_cursor: "c2" })));
    open();
    expect(await screen.findByText("Damaged")).toBeInTheDocument();
    expect(screen.queryByText("This is the start of this variant’s history.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByRole("button", { name: /Loading more/ })).toBeDisabled();
    expect(screen.getByText("Damaged")).toBeInTheDocument();
    expect(calls.some((call) => call.url === `${HISTORY_URL}?cursor=c2`)).toBe(true);

    release(reply(200, { items: MOVEMENTS.slice(2), next_cursor: null }));
    expect(await screen.findByText("Opening stock")).toBeInTheDocument();
    expect(screen.getByText("Damaged")).toBeInTheDocument();
    expect(screen.getByText("This is the start of this variant’s history.")).toBeInTheDocument();
  });

  it("shows the empty state for a variant with no changes yet (design 155)", async () => {
    serve(() => reply(200, { items: [], next_cursor: null }));
    open();
    expect(await screen.findByText("No stock changes yet")).toBeInTheDocument();
    expect(screen.getByText(/Changes you record with Adjust stock appear here/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Adjust stock" })).toBeInTheDocument();
  });

  it("adds a confirmed adjustment to the top of the history", async () => {
    const calls = catalogApi((call) => {
      if (call.method === "GET" && call.url === "/api/v1/catalog/products/p-jeans") return reply(200, JEANS);
      if (call.method === "GET") return reply(200, { items: MOVEMENTS, next_cursor: null });
      return reply(201, {
        movement: mv({ id: "m5", at: "2026-11-12T13:30:00Z", reason: "found", quantity: 1, on_hand_after: 3, actor_name: "Dana Demo" }),
        balance: { on_hand: 3, allocated: 1, available: 2, version: 2 },
      });
    });
    open();
    await screen.findByText("Damaged");
    fireEvent.click(screen.getByRole("button", { name: "Adjust stock" }));
    const sheet = screen.getByRole("dialog", { name: "Adjust stock" });
    expect(within(sheet).queryByRole("link", { name: /History/ })).not.toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole("radio", { name: "Found" }));
    fireEvent.change(within(sheet).getByLabelText("Quantity"), { target: { value: "1" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Save adjustment" }));
    await waitFor(() => expect(calls.filter((call) => call.method === "POST")).toHaveLength(1));
    expect(await screen.findByText("Saved. 32 · Blue: on hand 3, available 2.")).toBeInTheDocument();
    const today = screen.getByRole("region", { name: /^Today/ });
    const first = within(today).getAllByRole("listitem")[0];
    expect(first).toHaveTextContent("Found");
    expect(first).toHaveTextContent("On hand after 3 · By Dana Demo · 15:30");
    expect(screen.getByRole("group", { name: "Stock numbers" })).toHaveTextContent("On hand3Reserved1Available2");
  });

  it("tells sales, packing and dispatch staff they can't open it (design 156)", async () => {
    const calls = serve(() => reply(200, { items: MOVEMENTS, next_cursor: null }));
    open(catalogStaff());
    expect(await screen.findByText("You can’t open stock history")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to catalog" })).toHaveAttribute("href", "/more/catalog");
    expect(calls.filter((call) => call.url.startsWith(HISTORY_URL))).toHaveLength(0);
  });

  it("shows the same screen when the server refuses (forbidden)", async () => {
    serve(() => apiError(403, "forbidden"));
    open();
    expect(await screen.findByText("You can’t open stock history")).toBeInTheDocument();
  });

  it("is in Arabic with Latin digits", async () => {
    serve(() => reply(200, { items: MOVEMENTS, next_cursor: null }));
    open(catalogOwner({ user: { ...catalogOwner().user, locale: "ar" } }), "ar");
    expect(await screen.findByText(ar.catalog.reasons.damaged)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: ar.catalog.history.title })).toBeInTheDocument();
    expect(screen.getByText(ar.catalog.history.end)).toBeInTheDocument();
  });
});
