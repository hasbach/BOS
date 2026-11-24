import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { useRovingRadio } from "@/components/useRovingRadio";

const VALUES = ["a", "b", "c"] as const;

function Group({ initial = "a", dir }: { initial?: string; dir?: "rtl" | "ltr" }) {
  const [value, setValue] = useState(initial);
  const item = useRovingRadio<string>(VALUES, value, setValue);
  return (
    <div role="radiogroup" aria-label="Letters" dir={dir}>
      {VALUES.map((v) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} {...item(v)} onClick={() => setValue(v)}>
          {v.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

const radio = (name: string) => screen.getByRole("radio", { name });
const press = (name: string, key: string) => fireEvent.keyDown(radio(name), { key });

describe("useRovingRadio", () => {
  it("has one Tab stop: the selected radio", () => {
    render(<Group initial="b" />);
    expect(screen.getAllByRole("radio").map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
  });

  it("makes the first radio the Tab stop when none is selected", () => {
    render(<Group initial="none" />);
    expect(screen.getAllByRole("radio").map((r) => r.tabIndex)).toEqual([0, -1, -1]);
  });

  it("moves the selection and the focus with the arrow keys", () => {
    render(<Group />);
    radio("A").focus();
    press("A", "ArrowRight");
    expect(radio("B")).toBeChecked();
    expect(radio("B")).toHaveFocus();
    expect(screen.getAllByRole("radio").map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
    press("B", "ArrowDown");
    expect(radio("C")).toBeChecked();
    press("C", "ArrowUp");
    expect(radio("B")).toBeChecked();
    press("B", "ArrowLeft");
    expect(radio("A")).toBeChecked();
    expect(radio("A")).toHaveFocus();
  });

  it("wraps around at both ends", () => {
    render(<Group />);
    press("A", "ArrowLeft");
    expect(radio("C")).toBeChecked();
    expect(radio("C")).toHaveFocus();
    press("C", "ArrowRight");
    expect(radio("A")).toBeChecked();
  });

  it("jumps with Home and End", () => {
    render(<Group initial="b" />);
    press("B", "End");
    expect(radio("C")).toBeChecked();
    expect(radio("C")).toHaveFocus();
    press("C", "Home");
    expect(radio("A")).toBeChecked();
    expect(radio("A")).toHaveFocus();
  });

  it("ignores other keys", () => {
    render(<Group />);
    press("A", "x");
    expect(radio("A")).toBeChecked();
  });

  it("reverses Left and Right in right-to-left, and not Up and Down", () => {
    render(<Group dir="rtl" />);
    press("A", "ArrowLeft");
    expect(radio("B")).toBeChecked();
    press("B", "ArrowRight");
    expect(radio("A")).toBeChecked();
    press("A", "ArrowDown");
    expect(radio("B")).toBeChecked();
  });
});
