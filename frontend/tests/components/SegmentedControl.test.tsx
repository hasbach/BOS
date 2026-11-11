import { fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { SegmentedControl } from "@/components/SegmentedControl";

import { renderWithIntl } from "../utils";

type Currency = "usd" | "lbp" | "both";

const options = [
  { value: "usd", label: "USD" },
  { value: "lbp", label: "LBP" },
  { value: "both", label: "Both" },
] as const;

function Harness({ initial = "usd" }: { initial?: Currency }) {
  const [value, setValue] = useState<Currency>(initial);
  return <SegmentedControl<Currency> label="Currency" options={options} value={value} onChange={setValue} />;
}

describe("SegmentedControl", () => {
  it("is a named group exposing the selected option", () => {
    renderWithIntl(<Harness />);
    expect(screen.getByRole("radiogroup", { name: "Currency" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "USD" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "LBP" })).not.toBeChecked();
  });

  it("selects on click", () => {
    renderWithIntl(<Harness />);
    fireEvent.click(screen.getByRole("radio", { name: "LBP" }));
    expect(screen.getByRole("radio", { name: "LBP" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "USD" })).not.toBeChecked();
  });

  it("only the selected option is a tab stop", () => {
    renderWithIntl(<Harness initial="lbp" />);
    expect(screen.getByRole("radio", { name: "LBP" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("radio", { name: "USD" })).toHaveAttribute("tabindex", "-1");
  });

  it("moves the selection with the arrow keys and moves focus with it", () => {
    renderWithIntl(<Harness />);
    const usd = screen.getByRole("radio", { name: "USD" });
    usd.focus();
    fireEvent.keyDown(usd, { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: "LBP" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "LBP" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("radio", { name: "LBP" }), { key: "ArrowDown" });
    expect(screen.getByRole("radio", { name: "Both" })).toBeChecked();
  });

  it("wraps around at both ends", () => {
    renderWithIntl(<Harness />);
    fireEvent.keyDown(screen.getByRole("radio", { name: "USD" }), { key: "ArrowLeft" });
    expect(screen.getByRole("radio", { name: "Both" })).toBeChecked();
    fireEvent.keyDown(screen.getByRole("radio", { name: "Both" }), { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: "USD" })).toBeChecked();
  });

  it("jumps with Home and End", () => {
    renderWithIntl(<Harness initial="lbp" />);
    fireEvent.keyDown(screen.getByRole("radio", { name: "LBP" }), { key: "End" });
    expect(screen.getByRole("radio", { name: "Both" })).toBeChecked();
    fireEvent.keyDown(screen.getByRole("radio", { name: "Both" }), { key: "Home" });
    expect(screen.getByRole("radio", { name: "USD" })).toBeChecked();
  });

  it("reverses the arrow keys in a right-to-left layout", () => {
    renderWithIntl(
      <div dir="rtl">
        <Harness />
      </div>,
    );
    fireEvent.keyDown(screen.getByRole("radio", { name: "USD" }), { key: "ArrowLeft" });
    expect(screen.getByRole("radio", { name: "LBP" })).toBeChecked();
  });

  it("skips disabled options", () => {
    function WithDisabled() {
      const [value, setValue] = useState<Currency>("usd");
      return (
        <SegmentedControl<Currency>
          label="Currency"
          value={value}
          onChange={setValue}
          options={[
            { value: "usd", label: "USD" },
            { value: "lbp", label: "LBP", disabled: true },
            { value: "both", label: "Both" },
          ]}
        />
      );
    }
    renderWithIntl(<WithDisabled />);
    fireEvent.keyDown(screen.getByRole("radio", { name: "USD" }), { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: "Both" })).toBeChecked();
  });
});
