// Shared by the client guard (SessionGuard) and the server-side /me check (serverMe.ts). Kept out of
// session.ts because that file is a client module: a server component importing a value from it would
// get a client reference, not the value.

/** Error codes on /me that mean "go to sign-in". */
export const SIGN_IN_CODES: ReadonlySet<string> = new Set(["unauthenticated", "business_suspended", "business_pending"]);
