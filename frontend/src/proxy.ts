import createMiddleware from "next-intl/middleware";

import { routing } from "@/i18n/routing";

// A path without a locale is redirected by the device language (Accept-Language):
// Arabic -> /ar, anything else -> /en. After sign-in the user's saved language wins
// (built with sign-in, not here).
export default createMiddleware(routing);

export const config = {
  // Everything except the API, Next internals and files with an extension.
  matcher: ["/((?!api|_next|_vercel|.*\..*).*)"],
};
