// Data a page loaded on the server and hands to a screen, so the screen does not load it again on its
// first mount (SC-009, T088).
//
// Each server render gives its seed a new id. A screen uses a seed once: when the same page comes back
// from the router's cache (the browser's back and forward buttons reuse the earlier answer), the seed is
// recognised as already used and the screen loads fresh data from the API exactly as it did before
// server rendering, instead of showing what the server sent minutes ago.

import { useEffect, useState } from "react";

export interface Seed<T> {
  id: string;
  value: T;
}

const used = new Set<string>();

/** The seed's value for this mount, or undefined when there is none or it was already shown once. */
export function useSeed<T>(seed: Seed<T> | undefined): T | undefined {
  const [value] = useState(() => (seed !== undefined && !used.has(seed.id) ? seed.value : undefined));
  const id = value !== undefined ? seed?.id : undefined;
  useEffect(() => {
    // Marked after mount, so a development double render still uses it once.
    if (id !== undefined) used.add(id);
  }, [id]);
  return value;
}
