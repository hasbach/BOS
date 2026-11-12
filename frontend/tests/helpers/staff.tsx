import { render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";

import { MeContext } from "@/lib/session";
import type { StaffInvitation, StaffList, StaffMember } from "@/lib/staff";
import type { Me } from "@/lib/types";

import ar from "../../messages/ar.json";
import en from "../../messages/en.json";
import type { Call } from "./fetch";
import { mockApi, reply } from "./fetch";

export const STORES: Me["stores"] = [
  { id: "st-a", name: "Store A", whatsapp_number: null, has_logo: false, status: "active" },
  { id: "st-b", name: "Store B", whatsapp_number: null, has_logo: false, status: "active" },
];

const OWNER_PERMISSIONS = ["business.view", "store.view", "store.manage", "staff.view", "staff.manage", "staff.manage_owners", "settings.manage", "audit.view"];
const MANAGER_PERMISSIONS = ["business.view", "store.view", "store.manage", "staff.view", "staff.manage", "settings.manage"];
const SALES_PERMISSIONS = ["business.view", "store.view"];

type Kind = "owner" | "manager" | "sales";

/** The signed-in user. The owner is Samer, the manager Karim and the sales agent Dana: the same people as in the list. */
export function meAs(kind: Kind, locale: "en" | "ar" = "en"): Me {
  const who = {
    owner: { id: "u-samer", name: "Samer Demo", permissions: OWNER_PERMISSIONS },
    manager: { id: "u-karim", name: "Karim Demo", permissions: MANAGER_PERMISSIONS },
    sales: { id: "u-dana", name: "Dana Demo", permissions: SALES_PERMISSIONS },
  }[kind];
  return {
    user: { id: who.id, name: who.name, phone: "+961 70 000 011", email: null, locale, roles: [kind] },
    business: { id: "b1", name: "Demo Denim House Group", edition: "commerce" },
    permissions: who.permissions,
    all_stores: kind !== "sales",
    stores: STORES,
    tabs: ["sales", "more"],
    start_tab: "sales",
  };
}

export const member = (over: Partial<StaffMember> & Pick<StaffMember, "user_id" | "name">): StaffMember => ({
  phone: "+961 70 000 021",
  email: null,
  roles: ["sales"],
  all_stores: false,
  store_ids: ["st-a"],
  status: "active",
  ...over,
});

export const SAMER = member({ user_id: "u-samer", name: "Samer Demo", phone: "+961 70 000 011", roles: ["owner"], all_stores: true, store_ids: [] });
export const KARIM = member({ user_id: "u-karim", name: "Karim Demo", phone: null, email: "karim@demo.example", roles: ["manager"], all_stores: true, store_ids: [] });
export const DANA = member({ user_id: "u-dana", name: "Dana Demo", roles: ["sales", "packing"], store_ids: ["st-a"] });
export const NOUR = member({ user_id: "u-nour", name: "Nour Demo", phone: "+961 70 000 023", roles: ["dispatch"], store_ids: ["st-a", "st-b"] });
export const TALA = member({ user_id: "u-tala", name: "Tala Demo", phone: null, email: "tala@demo.example", roles: ["owner"], all_stores: true, store_ids: [] });
export const OMAR = member({ user_id: "u-omar", name: "Omar Demo", phone: "+961 70 000 024", roles: ["packing"], store_ids: ["st-b"], status: "inactive" });

export const HADI: StaffInvitation = {
  invitation_id: "inv-hadi",
  name: "Hadi Demo",
  phone: "+961 70 000 025",
  email: null,
  roles: ["sales"],
  all_stores: false,
  store_ids: ["st-b"],
  status: "pending",
  expires_at: "2026-11-18T10:00:00Z",
};
export const RITA: StaffInvitation = {
  ...HADI,
  invitation_id: "inv-rita",
  name: "Rita Demo",
  phone: null,
  email: "rita@demo.example",
  roles: ["packing"],
  all_stores: true,
  store_ids: [],
  status: "expired",
  expires_at: "2026-11-04T10:00:00Z",
};

export const LIST = (over: Partial<StaffList> = {}): StaffList => ({
  members: [SAMER, KARIM, DANA, NOUR, TALA, OMAR],
  invitations: [HADI, RITA],
  ...over,
});

/** Mocks /staff with `list` and sends every other call to `handler` (404 when it is not given). */
export function staffApi(list: StaffList, handler: (call: Call) => Response | Promise<Response> = () => reply(404)): Call[] {
  return mockApi((call) => {
    if (call.url === "/api/v1/staff" && call.method === "GET") return reply(200, list);
    if (call.url === "/api/v1/stores" && call.method === "GET") return reply(200, STORES);
    return handler(call);
  });
}

const catalogs = { en, ar };

export function renderAs(ui: ReactElement, kind: Kind = "owner", locale: "en" | "ar" = "en") {
  return render(
    <NextIntlClientProvider locale={locale} messages={catalogs[locale]}>
      <MeContext.Provider value={meAs(kind, locale)}>{ui}</MeContext.Provider>
    </NextIntlClientProvider>,
  );
}

export const LINK = { link: "https://app.bos.example/activate#Xk3-demo-token", expires_at: "2026-11-19T10:00:00Z" };
