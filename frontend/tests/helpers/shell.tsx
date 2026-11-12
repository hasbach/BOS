import { render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";

import { MeContext, MeSetterContext } from "@/lib/session";
import type { Me, Role } from "@/lib/types";

import ar from "../../messages/ar.json";
import en from "../../messages/en.json";

const catalogs = { en, ar };

export const OWNER_PERMISSIONS = ["business.view", "store.view", "store.manage", "staff.view", "staff.manage", "staff.manage_owners", "settings.manage", "audit.view"];
export const MANAGER_PERMISSIONS = ["business.view", "store.view", "store.manage", "staff.view", "staff.manage", "settings.manage"];
export const AGENT_PERMISSIONS = ["business.view", "store.view"];

export const TAB_ORDER = ["sales", "packing", "delivery", "orders", "more"] as const;

/** A signed-in person; every part can be replaced. Defaults to the owner. */
export function meWith(over: Partial<Omit<Me, "user">> & { user?: Partial<Me["user"]> } = {}): Me {
  const { user, ...rest } = over;
  return {
    user: { id: "u-samer", name: "Samer Demo", phone: "+961 70 000 011", email: null, locale: "en", roles: ["owner" as Role], ...user },
    business: { id: "b1", name: "Demo Denim House Group", edition: "commerce" },
    permissions: OWNER_PERMISSIONS,
    all_stores: true,
    stores: [
      { id: "st-a", name: "Store A", whatsapp_number: null, has_logo: false, status: "active" },
      { id: "st-b", name: "Store B", whatsapp_number: null, has_logo: false, status: "active" },
    ],
    tabs: [...TAB_ORDER],
    start_tab: "sales",
    ...rest,
  };
}

export const salesAgent = (over: Partial<Me["user"]> = {}): Me =>
  meWith({
    user: { id: "u-dana", name: "Dana Demo", roles: ["sales"], ...over },
    permissions: AGENT_PERMISSIONS,
    all_stores: false,
    tabs: ["sales", "orders", "more"],
    start_tab: "sales",
  });

/** Renders `ui` as `me`. `onMe` receives the person when a screen reports a changed profile. */
export function renderMe(ui: ReactElement, me: Me = meWith(), locale: "en" | "ar" = me.user.locale, onMe: (next: Me) => void = () => undefined) {
  return render(
    <NextIntlClientProvider locale={locale} messages={catalogs[locale]}>
      <MeSetterContext.Provider value={onMe}>
        <MeContext.Provider value={me}>{ui}</MeContext.Provider>
      </MeSetterContext.Provider>
    </NextIntlClientProvider>,
  );
}
