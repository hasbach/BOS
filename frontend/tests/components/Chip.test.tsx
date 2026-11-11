import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import type { ChipTone } from "@/components/Chip";

import { renderWithIntl } from "../utils";

const tones: ChipTone[] = ["neutral", "ok", "warn", "bad", "info", "storeA", "storeB"];

describe("Chip", () => {
  it.each(tones)("shows its text for the %s tone, so status is never colour alone", (tone) => {
    renderWithIntl(<Chip tone={tone}>Paid</Chip>);
    expect(screen.getByText("Paid")).toBeVisible();
  });
});

describe("Card", () => {
  it("renders its children in the requested element", () => {
    renderWithIntl(
      <Card as="section" aria-label="Summary">
        Content
      </Card>,
    );
    const card = screen.getByRole("region", { name: "Summary" });
    expect(card).toHaveTextContent("Content");
  });
});
