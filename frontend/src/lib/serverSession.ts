// The request-scoped server-side /me and screen data (see serverMe.ts, serverData.ts). React's cache()
// makes the layout and the page share one API call per request; nothing is kept between requests or
// between people.

import { cookies } from "next/headers";
import { cache } from "react";

import type { Business } from "./business";
import type { ProductFilters, ProductPage } from "./catalog";
import { fetchServerData, isBusiness, isProductPage, isStaffList, isStoreList } from "./serverData";
import { fetchServerMe } from "./serverMe";
import type { ServerMe } from "./serverMe";
import type { Seed } from "./seed";
import type { StaffList } from "./staff";
import type { Store } from "./stores";
import type { Me } from "./types";

export const getServerMe = cache(async (): Promise<ServerMe> => {
  // Reading cookies() also makes every signed-in page dynamic: never prerendered, never shared.
  const jar = await cookies();
  return fetchServerMe(jar, { baseUrl: process.env.BOS_API_INTERNAL_URL });
});

/**
 * A screen's first data, loaded on the server only when the server already knows the person, in the
 * address's language (otherwise the guard moves the page first) and with the permission the screen
 * checks. Anything else is left to the screen, which loads it in the browser as before.
 */
async function getScreenMe(locale: string, permission: string): Promise<Me | null> {
  const session = await getServerMe();
  if (session.k !== "ready" || session.me.user.locale !== locale || !session.me.permissions.includes(permission)) return null;
  return session.me;
}

async function loadScreenData<T>(path: `/${string}`, valid: (body: unknown) => body is T): Promise<T | null> {
  return fetchServerData(await cookies(), path, valid, { baseUrl: process.env.BOS_API_INTERNAL_URL });
}

async function loadFor<T>(locale: string, permission: string, path: `/${string}`, valid: (body: unknown) => body is T): Promise<T | null> {
  return (await getScreenMe(locale, permission)) ? loadScreenData(path, valid) : null;
}

/** Wraps data loaded for this render as a seed for the screen (lib/seed.ts); null gives no seed. */
export function toSeed<T>(value: T | null): Seed<T> | undefined {
  return value === null ? undefined : { id: crypto.randomUUID(), value };
}

export const getServerStaff = cache((locale: string): Promise<StaffList | null> => loadFor(locale, "staff.view", "/staff", isStaffList));
export const getServerStores = cache((locale: string): Promise<Store[] | null> => loadFor(locale, "store.view", "/stores", isStoreList));
export const getServerBusiness = cache((locale: string): Promise<Business | null> => loadFor(locale, "settings.manage", "/business", isBusiness));

export type CatalogSeedPage = { filters: Omit<ProductFilters, "cursor">; page: ProductPage };

export const getServerCatalog = cache(async (locale: string, noPhoto: boolean): Promise<CatalogSeedPage | null> => {
  const me = await getScreenMe(locale, "catalog.view");
  if (!me) return null;
  const filters = noPhoto && me.permissions.includes("catalog.manage") ? { no_photo: true } : {};
  const page = await loadScreenData(filters.no_photo ? "/catalog/products?no_photo=true" : "/catalog/products", isProductPage);
  return page ? { filters, page } : null;
});
