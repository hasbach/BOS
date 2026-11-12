import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InstallCard } from "@/components/InstallCard";
import { ServiceWorkerRegistrar } from "@/components/ServiceWorkerRegistrar";

import { renderWithIntl } from "../utils";

function installEvent(outcome: "accepted" | "dismissed" = "accepted") {
  const event = new Event("beforeinstallprompt", { cancelable: true }) as Event & {
    prompt: ReturnType<typeof vi.fn>;
    userChoice: Promise<{ outcome: string }>;
  };
  event.prompt = vi.fn(async () => undefined);
  event.userChoice = Promise.resolve({ outcome });
  return event;
}

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  window.localStorage.clear();
});

describe("install card (screen 131)", () => {
  it("is not shown until the browser says BOS can be installed", () => {
    renderWithIntl(<InstallCard />);
    expect(screen.queryByRole("region", { name: "Install BOS" })).not.toBeInTheDocument();
  });

  it("appears when the browser fires beforeinstallprompt, with the browser's own prompt held back", () => {
    renderWithIntl(<InstallCard />);
    const event = installEvent();
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    const card = screen.getByRole("region", { name: "Install BOS" });
    expect(card).toHaveTextContent("Add BOS to your home screen");
    expect(card).toHaveTextContent("It opens full-screen, like an app.");
    expect(screen.getByRole("button", { name: "Install" })).toBeInTheDocument();
    expect(event.prompt).not.toHaveBeenCalled();
  });

  it("Install opens the browser's prompt and then hides the card", async () => {
    renderWithIntl(<InstallCard />);
    const event = installEvent();
    act(() => {
      window.dispatchEvent(event);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Install" }));
    });
    expect(event.prompt).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("region", { name: "Install BOS" })).not.toBeInTheDocument();
  });

  it("Not now hides it and it stays hidden on the next visit", () => {
    const first = renderWithIntl(<InstallCard />);
    act(() => {
      window.dispatchEvent(installEvent());
    });
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("region", { name: "Install BOS" })).not.toBeInTheDocument();
    first.unmount();

    renderWithIntl(<InstallCard />);
    act(() => {
      window.dispatchEvent(installEvent());
    });
    expect(screen.queryByRole("region", { name: "Install BOS" })).not.toBeInTheDocument();
  });

  it("hides once BOS has been installed", () => {
    renderWithIntl(<InstallCard />);
    act(() => {
      window.dispatchEvent(installEvent());
    });
    act(() => {
      window.dispatchEvent(new Event("appinstalled"));
    });
    expect(screen.queryByRole("region", { name: "Install BOS" })).not.toBeInTheDocument();
  });

  it("on an iPhone replaces the button with the one-line instruction", () => {
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1");
    renderWithIntl(<InstallCard />);
    const card = screen.getByRole("region", { name: "Install BOS" });
    expect(card).toHaveTextContent("Tap Share, then Add to Home Screen.");
    expect(screen.queryByRole("button", { name: "Install" })).not.toBeInTheDocument();
  });

  it("reads in Arabic", () => {
    renderWithIntl(<InstallCard />, "ar");
    act(() => {
      window.dispatchEvent(installEvent());
    });
    expect(screen.getByRole("region", { name: "تثبيت BOS" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "تثبيت" })).toBeInTheDocument();
  });
});

describe("service worker registration", () => {
  function stubWorker() {
    const register = vi.fn(async () => ({}));
    Object.defineProperty(window.navigator, "serviceWorker", { value: { register }, configurable: true });
    return register;
  }
  afterEach(() => {
    Reflect.deleteProperty(window.navigator, "serviceWorker");
  });

  it("registers /sw.js in a production build", () => {
    vi.stubEnv("NODE_ENV", "production");
    const register = stubWorker();
    render(<ServiceWorkerRegistrar />);
    expect(register).toHaveBeenCalledWith("/sw.js", expect.objectContaining({ scope: "/" }));
  });

  it("does nothing in development and test, so `next dev` and the e2e suite are unaffected", () => {
    vi.stubEnv("NODE_ENV", "development");
    const register = stubWorker();
    render(<ServiceWorkerRegistrar />);
    expect(register).not.toHaveBeenCalled();
  });

  it("does not fail where there is no service worker support", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => render(<ServiceWorkerRegistrar />)).not.toThrow();
  });
});
