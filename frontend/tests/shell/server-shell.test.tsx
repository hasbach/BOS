import { isValidElement } from "react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ServerMe } from "@/lib/serverMe";

import { ME } from "../helpers/fetch";

// The shell layout and the home page are server components: called here as plain async functions
// with the server-side /me and the navigation helpers replaced.
const state = vi.hoisted(() => ({ session: { k: "unknown" } as ServerMe }));
const redirect = vi.hoisted(() =>
  vi.fn((args: { href: string; locale: string }) => {
    throw new Error(`REDIRECT ${args.locale}${args.href}`);
  }),
);
const preload = vi.hoisted(() => vi.fn());

vi.mock("@/lib/serverSession", () => ({ getServerMe: async () => state.session }));
vi.mock("@/i18n/navigation", async () => ({ ...(await import("../helpers/navigation")).navigationMock, redirect }));
vi.mock("next-intl/server", () => ({ setRequestLocale: () => undefined }));
vi.mock("react-dom", async (original) => ({ ...(await original<typeof import("react-dom")>()), preload }));

const { default: ShellLayout } = await import("@/app/[locale]/(shell)/layout");
const { default: HomePage } = await import("@/app/[locale]/(shell)/page");
const { SessionGuard } = await import("@/components/SessionGuard");
const { StartRedirect } = await import("@/app/[locale]/(shell)/StartRedirect");

const params = (locale: string) => Promise.resolve({ locale });

beforeEach(() => {
  redirect.mockClear();
  preload.mockClear();
});

describe("shell layout on the server", () => {
  it("seeds the guard with the person and does not preload /me", async () => {
    state.session = { k: "ready", me: ME("en") };
    const tree = (await ShellLayout({ children: <p>screen</p>, params: params("en") })) as ReactElement<{ initialMe?: unknown }>;

    expect(isValidElement(tree)).toBe(true);
    expect(tree.type).toBe(SessionGuard);
    expect(tree.props.initialMe).toEqual(ME("en"));
    expect(preload).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("sends a visitor without a session to sign-in in the address's language", async () => {
    state.session = { k: "sign-in" };
    await expect(ShellLayout({ children: null, params: params("ar") })).rejects.toThrow("REDIRECT ar/sign-in");
  });

  it("falls back to the client guard (and preloads /me) when the server could not tell", async () => {
    state.session = { k: "unknown" };
    const tree = (await ShellLayout({ children: null, params: params("en") })) as ReactElement<{ initialMe?: unknown }>;

    expect(tree.type).toBe(SessionGuard);
    expect(tree.props.initialMe).toBeUndefined();
    expect(preload).toHaveBeenCalledWith("/api/v1/me", { as: "fetch", crossOrigin: "anonymous" });
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe("home page on the server", () => {
  it("redirects to the start tab chosen by the server", async () => {
    state.session = { k: "ready", me: { ...ME("en"), start_tab: "packing" } };
    await expect(HomePage({ params: params("en") })).rejects.toThrow("REDIRECT en/packing");
  });

  it("redirects to the start tab in the saved language", async () => {
    state.session = { k: "ready", me: { ...ME("ar"), start_tab: "sales" } };
    await expect(HomePage({ params: params("en") })).rejects.toThrow("REDIRECT ar/sales");
  });

  it("goes to More when the start tab is unknown", async () => {
    state.session = { k: "ready", me: { ...ME("en"), start_tab: "nothing" } };
    await expect(HomePage({ params: params("en") })).rejects.toThrow("REDIRECT en/more");
  });

  it("leaves the move to the client when the server does not know the person", async () => {
    state.session = { k: "unknown" };
    const tree = (await HomePage({ params: params("en") })) as ReactElement;
    expect(tree.type).toBe(StartRedirect);
    expect(redirect).not.toHaveBeenCalled();
  });
});
