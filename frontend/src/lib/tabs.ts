// The five shell tabs. Which ones a person sees comes from GET /me (`tabs`), never from roles on the phone.

export const TAB_KEYS = ["sales", "packing", "delivery", "orders", "more"] as const;
export type TabKey = (typeof TAB_KEYS)[number];

export const isTabKey = (value: string): value is TabKey => (TAB_KEYS as readonly string[]).includes(value);

/** The tabs to show, in the designed order, limited to those the server sent. */
export function visibleTabs(tabs: readonly string[]): TabKey[] {
  return TAB_KEYS.filter((key) => tabs.includes(key));
}

export const tabPath = (key: TabKey) => `/${key}`;

/** Screens that carry the tab bar: the tab pages, the More menu and Language (design screens 103 to 119). */
export function showsTabBar(pathname: string): boolean {
  if (pathname === "/" || pathname === "") return true;
  if (pathname === "/more" || pathname === "/more/language") return true;
  return ["/sales", "/packing", "/delivery", "/orders"].includes(pathname);
}

export function activeTab(pathname: string): TabKey | null {
  const first = pathname.split("/")[1] ?? "";
  return isTabKey(first) ? first : null;
}
