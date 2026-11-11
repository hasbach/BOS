import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HomeContent } from "@/app/[locale]/HomeContent";

import { renderWithIntl } from "./utils";

describe("placeholder home page", () => {
  it("shows the product name and the English tagline", () => {
    renderWithIntl(<HomeContent />, "en");

    expect(screen.getByRole("heading", { name: "BOS" })).toBeInTheDocument();
    expect(screen.getByText("From Conversation to Delivery.")).toBeInTheDocument();
  });

  it("shows the Arabic tagline", () => {
    renderWithIntl(<HomeContent />, "ar");

    expect(screen.getByText("من أول رسالة لآخر طلبية")).toBeInTheDocument();
  });
});
