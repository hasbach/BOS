// The request-scoped server-side /me (see serverMe.ts). React's cache() makes the shell layout and
// the home page share one API call per request; nothing is kept between requests or between people.

import { cookies } from "next/headers";
import { cache } from "react";

import { fetchServerMe } from "./serverMe";
import type { ServerMe } from "./serverMe";

export const getServerMe = cache(async (): Promise<ServerMe> => {
  // Reading cookies() also makes every signed-in page dynamic: never prerendered, never shared.
  const jar = await cookies();
  return fetchServerMe(jar, { baseUrl: process.env.BOS_API_INTERNAL_URL });
});
