import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BetaContact, whatsappUrl } from "@/components/BetaContact";

import { renderWithIntl } from "../utils";

afterEach(() => vi.unstubAllEnvs());

describe("Beta WhatsApp contact", () => {
  it("opens a WhatsApp chat when a valid E.164 number is configured", () => {
    vi.stubEnv("NEXT_PUBLIC_BOS_SUPPORT_WHATSAPP", "+96170123456");
    renderWithIntl(<BetaContact />);

    const link = screen.getByRole("link", { name: "Message Beta on WhatsApp" });
    expect(link).toHaveAttribute("href", "https://wa.me/96170123456");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(screen.queryByText("Contact Beta Marketing Solutions")).not.toBeInTheDocument();
  });

  it("shows the Arabic button text", () => {
    vi.stubEnv("NEXT_PUBLIC_BOS_SUPPORT_WHATSAPP", "+96170123456");
    renderWithIntl(<BetaContact />, "ar");
    expect(screen.getByRole("link", { name: "راسل Beta عبر واتساب" })).toBeInTheDocument();
  });

  it("shows plain text and no link when the variable is not set", () => {
    vi.stubEnv("NEXT_PUBLIC_BOS_SUPPORT_WHATSAPP", "");
    renderWithIntl(<BetaContact />);

    expect(screen.getByText("Contact Beta Marketing Solutions")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it.each(["96170123456", "+0123456789", "+961 70 123 456", "not a number", "+123"])(
    "treats %s as not configured",
    (value) => {
      vi.stubEnv("NEXT_PUBLIC_BOS_SUPPORT_WHATSAPP", value);
      renderWithIntl(<BetaContact />);
      expect(screen.getByText("Contact Beta Marketing Solutions")).toBeInTheDocument();
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
    },
  );

  it("builds the wa.me link from digits only", () => {
    expect(whatsappUrl("+14155550123")).toBe("https://wa.me/14155550123");
    expect(whatsappUrl(undefined)).toBeNull();
  });
});
