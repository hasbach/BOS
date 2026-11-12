import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StoreDetail } from "@/app/[locale]/(shell)/more/stores/[storeId]/StoreDetail";

import { apiError, networkFailure, reply } from "../helpers/fetch";
import { resetNavigation } from "../helpers/navigation";
import { renderAs } from "../helpers/staff";
import { STORE_A, STORE_B, STORE_C, chooseLogo, imageFile, installFakeXhr, lastUpload, storesApi, writes } from "../helpers/stores";

vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);

beforeEach(() => {
  resetNavigation("/more/stores/st-b");
  installFakeXhr();
});
afterEach(() => vi.unstubAllGlobals());

const ALL = [STORE_A, STORE_B, STORE_C];
const type = (label: RegExp | string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const open = async (id = "st-b", kind: "owner" | "manager" | "sales" = "owner", locale: "en" | "ar" = "en") => {
  renderAs(<StoreDetail storeId={id} />, kind, locale);
  await screen.findByRole("heading", { level: 1 });
};
const saveButton = () => screen.getByRole("button", { name: "Save changes" });

describe("edit store (screen 83)", () => {
  it("shows the store's own name, number and logo state", async () => {
    storesApi(ALL);
    await open("st-a");
    expect(screen.getByRole("heading", { level: 1, name: "Edit store" })).toBeInTheDocument();
    expect(screen.getByLabelText("Store name")).toHaveValue("Store A");
    expect(screen.getByLabelText(/WhatsApp number/)).toHaveValue("+961 70 000 031");
    expect(screen.getByText("Current logo")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Logo of Store A" })).toHaveAttribute("src", "/api/v1/stores/st-a/logo");
  });

  it("saves the name and number, and only then says saved, with the number in its saved form (screen 87)", async () => {
    let release: (response: Response) => void = () => {};
    const calls = storesApi(ALL, () => new Promise<Response>((resolve) => (release = resolve)));
    await open();
    type("Store name", "Store B2");
    type(/WhatsApp number/, "070 000 032");
    fireEvent.click(saveButton());

    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({
      url: "/api/v1/stores/st-b",
      method: "PATCH",
      body: { name: "Store B2", whatsapp_number: "070 000 032" },
    });
    expect(screen.queryByText(/Saved/)).not.toBeInTheDocument(); // not before the server answers
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();

    release(reply(200, { ...STORE_B, name: "Store B2", whatsapp_number: "+96170000032" }));
    expect(await screen.findByText("Saved. The WhatsApp number was saved as +961 70 000 032.")).toBeInTheDocument();
    expect(screen.getByLabelText(/WhatsApp number/)).toHaveValue("+961 70 000 032");
    expect(screen.getByLabelText("Store name")).toHaveValue("Store B2");
  });

  it("says plain Saved when the number was already in its saved form", async () => {
    storesApi(ALL, () => reply(200, STORE_B));
    await open();
    fireEvent.click(saveButton());
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
  });

  it("clears the number when the field is emptied", async () => {
    const calls = storesApi(ALL, () => reply(200, { ...STORE_B, whatsapp_number: null }));
    await open();
    type(/WhatsApp number/, "");
    fireEvent.click(saveButton());
    await screen.findByText("Saved.");
    expect(writes(calls)[0]!.body).toEqual({ name: "Store B", whatsapp_number: null });
  });

  it("never shows success when the save fails", async () => {
    storesApi(ALL, () => networkFailure());
    await open();
    fireEvent.click(saveButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(/reach the server/);
    expect(screen.queryByText(/Saved/)).not.toBeInTheDocument();
  });

  it("shows the name and number clashes next to their fields", async () => {
    storesApi(ALL, () => apiError(409, "store_name_in_use"));
    await open();
    fireEvent.click(saveButton());
    expect(await screen.findByText(/already has this name/)).toBeInTheDocument();

    storesApi(ALL, () => apiError(409, "whatsapp_number_in_use"));
    fireEvent.click(saveButton());
    expect(await screen.findByText(/already uses this WhatsApp number/)).toBeInTheDocument();
  });

  it("shows an invalid number and an empty name from the server", async () => {
    storesApi(ALL, () => apiError(400, "validation_failed", { whatsapp_number: "invalid_phone", name: "required" }));
    await open();
    fireEvent.click(saveButton());
    expect(await screen.findByText(/This phone number is not valid/)).toBeInTheDocument();
    expect(screen.getByText("Enter a store name.")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("2 things to fix before you continue.");
  });

  it("asks for a name without calling the server", async () => {
    const calls = storesApi(ALL);
    await open();
    type("Store name", " ");
    fireEvent.click(saveButton());
    expect(screen.getByText("Enter a store name.")).toBeInTheDocument();
    expect(writes(calls)).toHaveLength(0);
  });

  it("shows not found for a store that is not in the list (screen 102)", async () => {
    storesApi(ALL);
    renderAs(<StoreDetail storeId="st-gone" />);
    expect(await screen.findByText("Not found")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to stores" })).toHaveAttribute("href", "/more/stores");
  });

  it("shows not found when the server says 404 on save", async () => {
    storesApi(ALL, () => apiError(404, "not_found"));
    await open();
    fireEvent.click(saveButton());
    expect(await screen.findByText("Not found")).toBeInTheDocument();
  });

  it("shows the not-allowed screen when the server answers forbidden on save", async () => {
    storesApi(ALL, () => apiError(403, "forbidden"));
    await open();
    fireEvent.click(saveButton());
    expect(await screen.findByText("You can’t change stores")).toBeInTheDocument();
  });

  it("is available in Arabic", async () => {
    storesApi([{ ...STORE_B, name: "متجر ب" }]);
    await open("st-b", "owner", "ar");
    expect(screen.getByRole("heading", { level: 1, name: "تعديل المتجر" })).toBeInTheDocument();
    expect(screen.getByLabelText("اسم المتجر")).toHaveValue("متجر ب");
    expect(screen.getByRole("button", { name: "إلغاء تفعيل المتجر" })).toBeInTheDocument();
  });
});

describe("edit store: logo (screens 84 to 86)", () => {
  it("uploads as soon as a file is picked, with progress, and keeps Save unavailable meanwhile", async () => {
    storesApi(ALL);
    await open();
    chooseLogo(imageFile("new-logo.webp", "image/webp"));

    expect(await screen.findByText("Uploading new-logo.webp")).toBeInTheDocument();
    expect(lastUpload()).toMatchObject({ method: "PUT", url: "/api/v1/stores/st-b/logo" });
    expect(lastUpload().headers["X-BOS-CSRF"]).toBe("1");
    expect(screen.getByRole("button", { name: "Waiting for the upload…" })).toBeDisabled();

    lastUpload().progress(6, 10);
    await waitFor(() => expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "60"));
    expect(screen.getByText("Wait for the upload to finish before saving.", { exact: false })).toBeInTheDocument();

    lastUpload().respond(200, { ...STORE_B, has_logo: true });
    expect(await screen.findByText("Current logo")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Logo of Store B" })).toHaveAttribute("src", "/api/v1/stores/st-b/logo?v=1");
    expect(saveButton()).toBeEnabled();
  });

  it("cancels an upload and keeps the previous state", async () => {
    storesApi(ALL);
    await open();
    chooseLogo(imageFile());
    await screen.findByRole("progressbar");
    fireEvent.click(screen.getByRole("button", { name: "Cancel upload" }));
    expect(lastUpload().aborted).toBe(true);
    expect(await screen.findByText("No logo yet")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("refuses a file over 2 MB or of the wrong type before sending anything", async () => {
    storesApi(ALL);
    await open("st-a");
    chooseLogo(imageFile("big.png", "image/png", 2 * 1024 * 1024 + 1));
    expect(screen.getByText("This image is larger than 2 MB. Choose a smaller one.")).toBeInTheDocument();
    chooseLogo(imageFile("a.pdf", "application/pdf"));
    expect(screen.getByText("This file is not a PNG, JPEG or WebP image. Choose another file.")).toBeInTheDocument();
    expect(screen.getByText("Current logo")).toBeInTheDocument(); // the previous logo stays
    expect(() => lastUpload()).toThrow();
  });

  it("shows file_too_large and file_not_image from the server next to the logo; the previous logo stays", async () => {
    storesApi(ALL);
    await open("st-a");
    chooseLogo(imageFile());
    await waitFor(() => lastUpload());
    lastUpload().respond(400, { error: { code: "file_too_large", message: "x" } });
    expect(await screen.findByText("This image is larger than 2 MB. Choose a smaller one.")).toBeInTheDocument();
    expect(screen.getByText("Current logo")).toBeInTheDocument();

    chooseLogo(imageFile());
    await waitFor(() => expect(screen.getByRole("progressbar")).toBeInTheDocument());
    lastUpload().respond(400, { error: { code: "file_not_image", message: "x" } });
    expect(await screen.findByText("This file is not a PNG, JPEG or WebP image. Choose another file.")).toBeInTheDocument();
    expect(screen.getByText("Current logo")).toBeInTheDocument();
  });

  it("says so when the upload cannot reach the server", async () => {
    storesApi(ALL);
    await open();
    chooseLogo(imageFile());
    await waitFor(() => lastUpload());
    lastUpload().fail();
    expect(await screen.findByText(/reach the server/)).toBeInTheDocument();
    expect(screen.getByText("No logo yet")).toBeInTheDocument();
  });

  it("removes the logo through the server and then shows initials", async () => {
    const calls = storesApi(ALL, () => reply(204));
    await open("st-a");
    fireEvent.click(screen.getByRole("button", { name: "Remove logo" }));
    expect(await screen.findByText("No logo yet")).toBeInTheDocument();
    expect(writes(calls)[0]).toMatchObject({ url: "/api/v1/stores/st-a/logo", method: "DELETE" });
    expect(screen.getByText("The logo was removed.")).toBeInTheDocument();
  });

  it("keeps the logo when removing it fails", async () => {
    storesApi(ALL, () => networkFailure());
    await open("st-a");
    fireEvent.click(screen.getByRole("button", { name: "Remove logo" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/reach the server/);
    expect(screen.getByText("Current logo")).toBeInTheDocument();
  });
});

describe("deactivate and reactivate (screens 88 to 90)", () => {
  const AFFECTED = [
    { kind: "employee", id: "u-hadi", name: "Hadi Demo", roles: ["sales"] },
    { kind: "employee", id: "u-lina", name: "Lina Demo", roles: ["sales", "packing"] },
    { kind: "invitation", id: "inv-nour", name: "Nour Demo", roles: ["packing"] },
  ];

  const deactivateButton = () => screen.getByRole("button", { name: "Deactivate store" });

  it("lists the affected people from the 409, then retries with confirm", async () => {
    let attempts = 0;
    const calls = storesApi(ALL, (call) => {
      attempts += 1;
      const confirmed = (call.body as { confirm?: boolean }).confirm === true;
      if (!confirmed) {
        return reply(409, { error: { code: "confirmation_required", message: "x", fields: {}, affected: AFFECTED } });
      }
      return reply(200, { ...STORE_B, status: "inactive" });
    });
    await open();
    fireEvent.click(deactivateButton());

    const sheet = await screen.findByRole("dialog", { name: "Deactivate Store B?" });
    expect(within(sheet).getByText("Hadi Demo")).toBeInTheDocument();
    expect(within(sheet).getByText("Sales")).toBeInTheDocument();
    expect(within(sheet).getByText("Lina Demo")).toBeInTheDocument();
    expect(within(sheet).getByText("Sales, Packing")).toBeInTheDocument();
    expect(within(sheet).getByText("Nour Demo")).toBeInTheDocument();
    expect(within(sheet).getByText("Invitation not accepted yet")).toBeInTheDocument();
    expect(within(sheet).getByText(/Nothing is deleted/)).toBeInTheDocument();
    expect(writes(calls)).toHaveLength(1);
    expect(writes(calls)[0]!.body).toEqual({ status: "inactive" }); // no confirm yet

    fireEvent.click(within(sheet).getByRole("button", { name: "Deactivate" }));
    await waitFor(() => expect(writes(calls)).toHaveLength(2));
    expect(writes(calls)[1]).toMatchObject({ url: "/api/v1/stores/st-b", method: "PATCH", body: { status: "inactive", confirm: true } });
    expect(await screen.findByText("Store B was deactivated.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reactivate store" })).toBeInTheDocument();
    expect(screen.getByText("Inactive. Employees can’t use this store.")).toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it("changes nothing when the sheet is cancelled", async () => {
    const calls = storesApi(ALL, () => reply(409, { error: { code: "confirmation_required", message: "x", fields: {}, affected: AFFECTED } }));
    await open();
    fireEvent.click(deactivateButton());
    const sheet = await screen.findByRole("dialog");
    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(writes(calls)).toHaveLength(1);
    expect(screen.queryByText(/was deactivated/)).not.toBeInTheDocument();
  });

  it("lists the affected people in Arabic with the confirmed role names", async () => {
    storesApi([{ ...STORE_B, name: "متجر ب" }], () =>
      reply(409, { error: { code: "confirmation_required", message: "x", fields: {}, affected: [{ kind: "employee", id: "u1", name: "هادي", roles: ["sales"] }] } }),
    );
    await open("st-b", "owner", "ar");
    fireEvent.click(screen.getByRole("button", { name: "إلغاء تفعيل المتجر" }));
    const sheet = await screen.findByRole("dialog", { name: "إلغاء تفعيل متجر ب؟" });
    expect(within(sheet).getByText("هادي")).toBeInTheDocument();
    expect(within(sheet).getByText("موظف مبيعات")).toBeInTheDocument();
  });

  it("deactivates at once when the server needs no confirmation", async () => {
    storesApi(ALL, () => reply(200, { ...STORE_B, status: "inactive" }));
    await open();
    fireEvent.click(deactivateButton());
    expect(await screen.findByText("Store B was deactivated.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("explains last_active_store and changes nothing (screen 89)", async () => {
    storesApi(ALL, () => apiError(409, "last_active_store"));
    await open("st-a");
    fireEvent.click(deactivateButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("A business must keep at least one active store. Add or reactivate another store first.");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(deactivateButton()).toBeInTheDocument();
  });

  it("closes the sheet and says why when the confirmed request is refused", async () => {
    storesApi(ALL, (call) =>
      (call.body as { confirm?: boolean }).confirm
        ? apiError(409, "last_active_store")
        : reply(409, { error: { code: "confirmation_required", message: "x", fields: {}, affected: AFFECTED } }),
    );
    await open();
    fireEvent.click(deactivateButton());
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Deactivate" }));
    expect(await screen.findByText(/must keep at least one active store/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("reactivates an inactive store without a confirmation (screen 90)", async () => {
    const calls = storesApi(ALL, () => reply(200, { ...STORE_C, status: "active" }));
    await open("st-c");
    expect(screen.getByText("Inactive. Employees can’t use this store.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Deactivate store" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reactivate store" }));
    expect(await screen.findByText("Store C is active again.")).toBeInTheDocument();
    expect(writes(calls)[0]).toMatchObject({ url: "/api/v1/stores/st-c", method: "PATCH", body: { status: "active" } });
    expect(screen.getByRole("button", { name: "Deactivate store" })).toBeInTheDocument();
  });

  it("shows the name clash when reactivating is refused", async () => {
    storesApi(ALL, () => apiError(409, "store_name_in_use"));
    await open("st-c");
    fireEvent.click(screen.getByRole("button", { name: "Reactivate store" }));
    expect(await screen.findByText(/already has this name/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reactivate store" })).toBeInTheDocument();
  });
});

describe("store pages for a sales agent (screens 97 and 98)", () => {
  it("shows a read-only page: no fields, no logo buttons, no Deactivate, no Save", async () => {
    const calls = storesApi([STORE_B]);
    renderAs(<StoreDetail storeId="st-b" />, "sales");
    expect(await screen.findByText("You can look but not change. Ask an owner or manager to change this store.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Store B" })).toBeInTheDocument();
    expect(screen.getByText("+961 70 000 032")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByTestId("logo-input")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to stores" })).toHaveAttribute("href", "/more/stores");
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("shows not found for a store the agent does not have (the server never listed it)", async () => {
    storesApi([STORE_B]);
    renderAs(<StoreDetail storeId="st-a" />, "sales");
    expect(await screen.findByText("Not found")).toBeInTheDocument();
  });
});
