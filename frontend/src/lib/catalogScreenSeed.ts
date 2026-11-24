import type { Seed } from "./seed";
import type { Me } from "./types";

export type CatalogScreenSeed<T> = Seed<{ scope: string; data: T }>;

/** Product reads can differ by user, tenant, language, catalog permissions and store access. */
export function catalogScreenScope(me: Me): string | null {
  // The shell's /me guard checks only the shape it needs; a seed needs the full store scope.
  if (typeof me.business.id !== "string" || !me.business.id || typeof me.all_stores !== "boolean" ||
    !me.stores.every((store) => typeof store?.id === "string" && store.id && (store.status === "active" || store.status === "inactive"))) return null;
  return JSON.stringify([
    me.user.id, me.business.id, me.user.locale, me.all_stores,
    ["catalog.view", "catalog.manage", "stock.adjust"].filter((permission) => me.permissions.includes(permission)),
    me.stores.filter((store) => store.status === "active").map((store) => store.id).sort(),
  ]);
}
