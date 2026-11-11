import type { AnchorHTMLAttributes, ReactNode } from "react";
import { vi } from "vitest";

// Stand-in for "@/i18n/navigation": the real one needs a mounted Next.js router.
export const router = { replace: vi.fn(), push: vi.fn(), back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() };
export const nav = { pathname: "/" };

export const navigationMock = {
  useRouter: () => router,
  usePathname: () => nav.pathname,
  redirect: vi.fn(),
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
};

export function resetNavigation(pathname = "/") {
  router.replace.mockReset();
  router.push.mockReset();
  nav.pathname = pathname;
}
