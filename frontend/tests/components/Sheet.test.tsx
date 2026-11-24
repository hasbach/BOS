import { fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Sheet } from "@/components/Sheet";

import { ar, renderWithIntl } from "../utils";

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Choose a store" footer={<button type="button">Confirm</button>}>
        <p>Body</p>
      </Sheet>
    </>
  );
}

function openSheet() {
  const opener = screen.getByRole("button", { name: "Open" });
  opener.focus();
  fireEvent.click(opener);
  return opener;
}

describe("Sheet", () => {
  it("renders nothing while closed", () => {
    renderWithIntl(<Harness />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("is a modal dialog labelled by its title", () => {
    renderWithIntl(<Harness />);
    openSheet();
    const dialog = screen.getByRole("dialog", { name: "Choose a store" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("moves focus into the dialog when it opens", () => {
    renderWithIntl(<Harness />);
    openSheet();
    expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement);
  });

  it("closes on Escape and returns focus to the opener", () => {
    renderWithIntl(<Harness />);
    const opener = openSheet();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("closes on a backdrop click but not on a click inside the sheet", () => {
    renderWithIntl(<Harness />);
    const opener = openSheet();
    fireEvent.click(screen.getByText("Body"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("sheet-backdrop"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("closes from the close button, named in the current language", () => {
    renderWithIntl(<Harness />, "ar");
    openSheet();
    fireEvent.click(screen.getByRole("button", { name: ar.ui.close }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps Tab inside the dialog", () => {
    renderWithIntl(<Harness />);
    openSheet();
    const confirm = screen.getByRole("button", { name: "Confirm" });
    confirm.focus();
    fireEvent.keyDown(confirm, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  });

  it("wraps around the tabbable radio, not the inactive radio after it", () => {
    renderWithIntl(
      <Sheet open onClose={() => {}} title="Choose a store">
        <button type="button" role="radio" aria-checked="true">All stores</button>
        <button type="button" role="radio" aria-checked="false" tabIndex={-1}>Store B</button>
      </Sheet>,
    );
    const current = screen.getByRole("radio", { name: "All stores" });
    const close = screen.getByRole("button", { name: "Close" });
    current.focus();
    fireEvent.keyDown(current, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(current).toHaveFocus();
  });

  it("calls onClose when asked to close", () => {
    const onClose = vi.fn();
    renderWithIntl(
      <Sheet open onClose={onClose} title="T">
        x
      </Sheet>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
