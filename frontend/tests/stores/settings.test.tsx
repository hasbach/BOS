import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsForm } from "@/app/[locale]/(shell)/more/settings/SettingsForm";
import type { Business } from "@/lib/business";

import { apiError, mockApi, networkFailure, reply } from "../helpers/fetch";
import { resetNavigation } from "../helpers/navigation";
import { renderAs } from "../helpers/staff";
import { writes } from "../helpers/stores";

vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);

beforeEach(() => resetNavigation("/more/settings"));
afterEach(() => vi.unstubAllGlobals());

const BUSINESS: Business = {
  id: "b1",
  name: "Demo Denim House Group",
  edition: "commerce",
  default_currency: "USD",
  usd_lbp_rate: "89500.00",
  default_delivery_fee: "3.00",
  default_delivery_fee_currency: "USD",
  timezone: "Asia/Beirut",
};

function businessApi(handler: Parameters<typeof mockApi>[0] = () => reply(404)) {
  return mockApi((call) => (call.url === "/api/v1/business" && call.method === "GET" ? reply(200, BUSINESS) : handler(call)));
}

const open = async (kind: "owner" | "manager" | "sales" = "owner", locale: "en" | "ar" = "en") => {
  renderAs(<SettingsForm />, kind, locale);
  await screen.findByLabelText(locale === "ar" ? "اسم النشاط" : "Business name");
};
const type = (label: RegExp | string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const RATE = /Exchange rate/;
const FEE = "Default delivery fee";
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

describe("settings (screen 91)", () => {
  it("shows the saved values with separators and Latin digits", async () => {
    businessApi();
    await open();
    expect(screen.getByLabelText("Business name")).toHaveValue("Demo Denim House Group");
    expect(screen.getByLabelText(RATE)).toHaveValue("89,500");
    expect(screen.getByLabelText(FEE)).toHaveValue("3.00");
    expect(screen.getAllByRole("radio", { checked: true }).map((radio) => radio.textContent)).toEqual(["USD", "USD"]);
    expect(screen.getByText("Digits 0–9 or ٠–٩ both work. Use a dot or ٫ for decimals.")).toBeInTheDocument();
  });

  it("keeps Latin digits in Arabic", async () => {
    businessApi();
    await open("owner", "ar");
    expect(screen.getByLabelText(/سعر الصرف/)).toHaveValue("89,500");
    expect(screen.getByLabelText("رسم التوصيل الافتراضي")).toHaveValue("3.00");
  });

  it("strips typed separators and sends plain decimal strings, then shows the saved values (screens 93 and 94)", async () => {
    let release: (response: Response) => void = () => {};
    const calls = businessApi(() => new Promise<Response>((resolve) => (release = resolve)));
    await open();
    type(RATE, "90,000");
    type(FEE, "3.5");
    fireEvent.click(screen.getAllByRole("radio", { name: "LBP" })[1]!);
    save();

    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({
      url: "/api/v1/business",
      method: "PATCH",
      body: {
        name: "Demo Denim House Group",
        default_currency: "USD",
        usd_lbp_rate: "90000",
        default_delivery_fee: "3.5",
        default_delivery_fee_currency: "LBP",
      },
    });
    expect(writes(calls)[0]!.headers["X-BOS-CSRF"]).toBe("1");
    // While the request is out: dimmed, busy, and no success yet.
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(screen.queryByText(/^Saved/)).not.toBeInTheDocument();

    release(reply(200, { ...BUSINESS, usd_lbp_rate: "90000.00", default_delivery_fee: "3.50", default_delivery_fee_currency: "LBP" }));
    expect(await screen.findByText("Saved. The new values apply from now on.")).toBeInTheDocument();
    expect(screen.getByLabelText(RATE)).toHaveValue("90,000");
    expect(screen.getByLabelText(FEE)).toHaveValue("3.50");
  });

  it("lets a manager save too", async () => {
    const calls = businessApi(() => reply(200, BUSINESS));
    await open("manager");
    save();
    expect(await screen.findByText("Saved. The new values apply from now on.")).toBeInTheDocument();
    expect(writes(calls)).toHaveLength(1);
  });

  it("shows field errors next to their fields and sends nothing (screen 92)", async () => {
    const calls = businessApi();
    await open();
    type("Business name", "");
    type(RATE, "abc");
    type(FEE, "3.555");
    save();
    expect(screen.getByText("Enter a business name.")).toBeInTheDocument();
    expect(screen.getByText("Enter the rate as a number above 0, with a dot for decimals. Example: 89500")).toBeInTheDocument();
    expect(screen.getByText("Use at most 2 decimals. Example: 3.50")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("3 things to fix before saving.");
    expect(writes(calls)).toHaveLength(0);
  });

  it("accepts Arabic-Indic digits and separators and sends ASCII decimal strings (R48)", async () => {
    const calls = businessApi();
    await open();
    type(RATE, "٨٩٬٥٠٠");
    type(FEE, "٢٫٥");
    save();
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]!.body).toMatchObject({ usd_lbp_rate: "89500", default_delivery_fee: "2.5" });
  });

  it("accepts extended Arabic-Indic digits and the Arabic screen too", async () => {
    const calls = businessApi();
    await open("owner", "ar");
    type(/سعر الصرف/, "۹۰٬۰۰۰");
    type("رسم التوصيل الافتراضي", "٣٫٥٠");
    fireEvent.click(screen.getByRole("button", { name: "حفظ التغييرات" }));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]!.body).toMatchObject({ usd_lbp_rate: "90000", default_delivery_fee: "3.50" });
  });

  it("still refuses a decimal comma instead of guessing (3,50 is not 350)", async () => {
    const calls = businessApi();
    await open();
    type(RATE, "89,500");
    type(FEE, "3,50");
    save();
    expect(screen.getByText("Enter an amount with up to 2 decimals. Example: 3.50")).toBeInTheDocument();
    expect(writes(calls)).toHaveLength(0);
  });

  it("applies the limits before sending", async () => {
    const calls = businessApi();
    await open();
    type(RATE, "0");
    type(FEE, "100,000,001");
    save();
    expect(screen.getByText(/Enter the rate as a number above 0/)).toBeInTheDocument();
    expect(screen.getByText("The fee can’t be more than 100,000,000.")).toBeInTheDocument();
    type(RATE, "10,000,001");
    save();
    expect(screen.getByText("The rate can’t be more than 10,000,000.")).toBeInTheDocument();
    expect(writes(calls)).toHaveLength(0);
  });

  it("accepts a fee of 0 for free delivery", async () => {
    const calls = businessApi(() => reply(200, { ...BUSINESS, default_delivery_fee: "0.00" }));
    await open();
    type(FEE, "0");
    save();
    await screen.findByText("Saved. The new values apply from now on.");
    expect(writes(calls)[0]!.body).toMatchObject({ default_delivery_fee: "0" });
  });

  it("shows the server's field errors when it refuses", async () => {
    businessApi(() => apiError(400, "validation_failed", { usd_lbp_rate: "invalid", default_delivery_fee: "invalid", name: "too_long" }));
    await open();
    save();
    expect(await screen.findByText("Use at most 120 characters.")).toBeInTheDocument();
    expect(screen.getByText(/Enter the rate as a number above 0/)).toBeInTheDocument();
    expect(screen.getByText("Enter an amount with up to 2 decimals. Example: 3.50")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("3 things to fix before saving.");
    expect(screen.queryByText(/^Saved/)).not.toBeInTheDocument();
  });

  it("says nothing was saved, keeps what was typed and offers Try again when there is no answer (screen 95)", async () => {
    let fail = true;
    const calls = businessApi(() => (fail ? networkFailure() : reply(200, { ...BUSINESS, usd_lbp_rate: "90000.00" })));
    await open();
    type(RATE, "90,000");
    save();
    expect(await screen.findByRole("alert")).toHaveTextContent("Not saved. We couldn’t reach the server.");
    expect(screen.queryByText(/^Saved/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(RATE)).toHaveValue("90,000");

    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Saved. The new values apply from now on.")).toBeInTheDocument();
    expect(writes(calls)).toHaveLength(2);
  });

  it("shows other server errors as a message, never as success", async () => {
    businessApi(() => apiError(500, "internal_error"));
    await open();
    save();
    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong on our side");
  });

  it("offers retry when the settings cannot be loaded", async () => {
    let fail = true;
    mockApi(() => (fail ? networkFailure() : reply(200, BUSINESS)));
    renderAs(<SettingsForm />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t load settings");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("Business name")).toBeInTheDocument();
  });

  it("shows the not-allowed screen when the server answers forbidden", async () => {
    mockApi(() => apiError(403, "forbidden"));
    renderAs(<SettingsForm />);
    expect(await screen.findByText("You can’t open Settings")).toBeInTheDocument();
  });
});

describe("settings for a sales agent (screen 99)", () => {
  it("shows the not-allowed screen, loads nothing and offers nothing to change", () => {
    const calls = mockApi(() => reply(200, BUSINESS));
    renderAs(<SettingsForm />, "sales");
    expect(screen.getByText("You can’t open Settings")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to More" })).toHaveAttribute("href", "/more");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it("is in Arabic", () => {
    renderAs(<SettingsForm />, "sales", "ar");
    expect(screen.getByText("لا يمكنك فتح الإعدادات")).toBeInTheDocument();
  });
});
