import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NewStore } from "@/app/[locale]/(shell)/more/stores/new/NewStore";

import { apiError, networkFailure, reply } from "../helpers/fetch";
import { resetNavigation, router } from "../helpers/navigation";
import { renderAs } from "../helpers/staff";
import { STORE_B, chooseLogo, imageFile, installFakeXhr, lastUpload, storesApi, writes } from "../helpers/stores";

vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);

beforeEach(() => {
  resetNavigation("/more/stores/new");
  installFakeXhr();
});
afterEach(() => vi.unstubAllGlobals());

const type = (label: RegExp | string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save store" }));

describe("add store", () => {
  it("creates the store with the number as typed, then goes back to the list", async () => {
    const calls = storesApi([], () => reply(201, STORE_B));
    renderAs(<NewStore />);
    type("Store name", "  Store B ");
    type(/WhatsApp number/, "070 000 032");
    save();
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/more/stores"));
    expect(writes(calls)).toHaveLength(1);
    expect(writes(calls)[0]).toMatchObject({
      url: "/api/v1/stores",
      method: "POST",
      body: { name: "Store B", whatsapp_number: "070 000 032" },
    });
    expect(writes(calls)[0]!.headers["X-BOS-CSRF"]).toBe("1");
  });

  it("sends no number when the field is empty", async () => {
    const calls = storesApi([], () => reply(201, STORE_B));
    renderAs(<NewStore />);
    type("Store name", "Store B");
    save();
    await waitFor(() => expect(router.replace).toHaveBeenCalled());
    expect(writes(calls)[0]!.body).toEqual({ name: "Store B", whatsapp_number: null });
  });

  it("asks for a name without calling the server", () => {
    const calls = storesApi([]);
    renderAs(<NewStore />);
    save();
    expect(screen.getByText("Enter a store name.")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("1 thing to fix before you continue.");
    expect(writes(calls)).toHaveLength(0);
  });

  it("uploads the chosen logo right after the store is created", async () => {
    const calls = storesApi([], () => reply(201, STORE_B));
    renderAs(<NewStore />);
    type("Store name", "Store B");
    chooseLogo(imageFile("store-b-logo.png"));
    expect(await screen.findByText("store-b-logo.png")).toBeInTheDocument();
    expect(screen.getByText("Uploads when you save the store.")).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: "Logo preview" })).toBeInTheDocument();

    save();
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    await waitFor(() => lastUpload());
    expect(lastUpload()).toMatchObject({ method: "PUT", url: "/api/v1/stores/st-b/logo" });
    expect(router.replace).not.toHaveBeenCalled(); // not before the logo is in
    lastUpload().respond(200, { ...STORE_B, has_logo: true });
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/more/stores"));
  });

  it("goes to Edit store with the logo error when the logo is refused, because the store exists (screen 82)", async () => {
    storesApi([], () => reply(201, STORE_B));
    renderAs(<NewStore />);
    type("Store name", "Store B");
    chooseLogo(imageFile("notes.png"));
    save();
    await waitFor(() => lastUpload());
    lastUpload().respond(400, { error: { code: "file_not_image", message: "x" } });

    expect(await screen.findByRole("heading", { name: "Edit store" })).toBeInTheDocument();
    expect(screen.getByText("Store B was created, but its logo was not saved. Choose the logo again.")).toBeInTheDocument();
    expect(screen.getByText("This file is not a PNG, JPEG or WebP image. Choose another file.")).toBeInTheDocument();
    expect(screen.getByLabelText("Store name")).toHaveValue("Store B");
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("checks the logo's type and size before choosing it, and keeps no file", () => {
    renderAs(<NewStore />);
    chooseLogo(imageFile("a.gif", "image/gif"));
    expect(screen.getByText("This file is not a PNG, JPEG or WebP image. Choose another file.")).toBeInTheDocument();
    chooseLogo(imageFile("big.png", "image/png", 3 * 1024 * 1024));
    expect(screen.getByText("This image is larger than 2 MB. Choose a smaller one.")).toBeInTheDocument();
    expect(screen.getByText("No logo yet")).toBeInTheDocument();
    chooseLogo(imageFile("ok.png"));
    expect(screen.queryByText(/larger than 2 MB/)).not.toBeInTheDocument();
  });

  it("does not save the store while a refused logo is shown, and moves focus to the logo (P5)", () => {
    const calls = storesApi([], () => reply(201, STORE_B));
    renderAs(<NewStore />);
    type("Store name", "Store B");
    chooseLogo(imageFile("big.png", "image/png", 3 * 1024 * 1024));
    save();
    expect(writes(calls)).toHaveLength(0);
    expect(screen.getByText("1 thing to fix before you continue.")).toBeInTheDocument();
    const choose = screen.getByRole("button", { name: /Choose logo/ });
    expect(choose).toHaveFocus();
    expect(choose).toHaveAccessibleDescription("This image is larger than 2 MB. Choose a smaller one.");
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("counts a refused logo with a missing name", () => {
    const calls = storesApi([]);
    renderAs(<NewStore />);
    chooseLogo(imageFile("a.gif", "image/gif"));
    save();
    expect(writes(calls)).toHaveLength(0);
    expect(screen.getByText("2 things to fix before you continue.")).toBeInTheDocument();
  });

  it("saves without a logo once the refused file is removed", async () => {
    const calls = storesApi([], () => reply(201, STORE_B));
    renderAs(<NewStore />);
    type("Store name", "Store B");
    chooseLogo(imageFile("a.gif", "image/gif"));
    fireEvent.click(screen.getByRole("button", { name: "Remove logo" }));
    expect(screen.queryByText(/not a PNG/)).not.toBeInTheDocument();
    save();
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/more/stores"));
    expect(writes(calls)).toHaveLength(1);
  });

  it("saves with the logo once a valid file replaces the refused one", async () => {
    const calls = storesApi([], () => reply(201, STORE_B));
    renderAs(<NewStore />);
    type("Store name", "Store B");
    chooseLogo(imageFile("a.gif", "image/gif"));
    chooseLogo(imageFile("ok.png"));
    save();
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    await waitFor(() => expect(lastUpload()).toMatchObject({ url: "/api/v1/stores/st-b/logo" }));
  });

  it("removes a chosen logo before saving", async () => {
    renderAs(<NewStore />);
    chooseLogo(imageFile("ok.png"));
    expect(await screen.findByText("ok.png")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove logo" }));
    expect(screen.getByText("No logo yet")).toBeInTheDocument();
  });

  it("shows the name clash next to the name (screen 80)", async () => {
    storesApi([], () => apiError(409, "store_name_in_use"));
    renderAs(<NewStore />);
    type("Store name", "Store A");
    save();
    expect(await screen.findByText(/already has this name/)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("The store was not saved.");
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("shows the number clash next to the number", async () => {
    storesApi([], () => apiError(409, "whatsapp_number_in_use"));
    renderAs(<NewStore />);
    type("Store name", "Store B");
    type(/WhatsApp number/, "70 000 031");
    save();
    expect(await screen.findByText(/already uses this WhatsApp number/)).toBeInTheDocument();
  });

  it("shows an invalid number with a working example (screen 81)", async () => {
    storesApi([], () => apiError(400, "validation_failed", { whatsapp_number: "invalid_phone" }));
    renderAs(<NewStore />);
    type("Store name", "Store B");
    type(/WhatsApp number/, "12 345");
    save();
    expect(await screen.findByText(/This phone number is not valid/)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("1 thing to fix before you continue.");
  });

  it("maps a too-long name from the server", async () => {
    storesApi([], () => apiError(400, "validation_failed", { name: "too_long" }));
    renderAs(<NewStore />);
    type("Store name", "x");
    save();
    expect(await screen.findByText("Use at most 80 characters.")).toBeInTheDocument();
  });

  it("says so and creates nothing when the server cannot be reached", async () => {
    storesApi([], () => networkFailure());
    renderAs(<NewStore />);
    type("Store name", "Store B");
    save();
    expect(await screen.findByRole("alert")).toHaveTextContent(/reach the server/);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("shows the not-allowed screen to a sales agent (screen 98)", () => {
    renderAs(<NewStore />, "sales");
    expect(screen.getByText("You can’t change stores")).toBeInTheDocument();
    expect(screen.queryByLabelText("Store name")).not.toBeInTheDocument();
  });

  it("shows the not-allowed screen when the server answers forbidden", async () => {
    storesApi([], () => apiError(403, "forbidden"));
    renderAs(<NewStore />);
    type("Store name", "Store B");
    save();
    expect(await screen.findByText("You can’t change stores")).toBeInTheDocument();
  });

  it("is in Arabic", () => {
    renderAs(<NewStore />, "owner", "ar");
    expect(screen.getByRole("heading", { name: "إضافة متجر" })).toBeInTheDocument();
    expect(screen.getByLabelText("اسم المتجر")).toBeInTheDocument();
  });
});
