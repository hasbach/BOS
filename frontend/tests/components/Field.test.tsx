import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Field } from "@/components/Field";

import { renderWithIntl } from "../utils";

describe("Field", () => {
  it("shows a visible label tied to the input", () => {
    renderWithIntl(<Field label="Store name" />);
    const input = screen.getByLabelText("Store name");
    expect(input.tagName).toBe("INPUT");
    expect(screen.getByText("Store name").tagName).toBe("LABEL");
  });

  it("links helper text with aria-describedby", () => {
    renderWithIntl(<Field label="Store name" helper="Customers see this name." />);
    const input = screen.getByLabelText("Store name");
    expect(input).toHaveAccessibleDescription("Customers see this name.");
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  it("links the error text and marks the field invalid", () => {
    renderWithIntl(<Field label="Store name" helper="Helper" error="Name already used" />);
    const input = screen.getByLabelText("Store name");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Helper Name already used");
    expect(screen.getByText("Name already used")).toBeVisible();
  });

  it("keeps a describedby the caller passed", () => {
    renderWithIntl(
      <>
        <p id="extra">Extra</p>
        <Field label="Store name" aria-describedby="extra" error="Bad" />
      </>,
    );
    expect(screen.getByLabelText("Store name")).toHaveAccessibleDescription("Extra Bad");
  });

  it("renders a textarea when multiline", () => {
    renderWithIntl(<Field label="Notes" multiline />);
    expect(screen.getByLabelText("Notes").tagName).toBe("TEXTAREA");
  });

  it("passes input attributes through", () => {
    renderWithIntl(<Field label="Phone" type="tel" disabled placeholder="70 123 456" />);
    const input = screen.getByLabelText("Phone");
    expect(input).toHaveAttribute("type", "tel");
    expect(input).toBeDisabled();
  });
});
