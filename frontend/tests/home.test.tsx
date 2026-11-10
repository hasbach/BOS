import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import HomePage from "@/app/page";

describe("placeholder home page", () => {
  it("shows the product name and both taglines", () => {
    render(<HomePage />);

    expect(screen.getByRole("heading", { name: "BOS" })).toBeInTheDocument();
    expect(screen.getByText("From Conversation to Delivery.")).toBeInTheDocument();
    expect(screen.getByText("من أول رسالة لآخر طلبية")).toHaveAttribute("dir", "rtl");
  });
});
