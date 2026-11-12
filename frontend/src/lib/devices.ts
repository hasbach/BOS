// Own sessions (contracts/openapi.yaml: /me/sessions).

export interface Session {
  id: string;
  browser: string | null;
  os: string | null;
  created_at: string;
  last_seen_at: string;
  current: boolean;
}

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** "Chrome on Android" / "Chrome على Android"; one name when the other is unknown; "Unknown device" when both are. */
export function deviceLabel(session: Pick<Session, "browser" | "os">, t: Translate): string {
  if (session.browser && session.os) return t("devices.label", { browser: session.browser, os: session.os });
  return session.browser ?? session.os ?? t("devices.unknown");
}

/** This device first, then the others in the order the server gave. */
export const currentFirst = (sessions: Session[]): Session[] => [...sessions.filter((s) => s.current), ...sessions.filter((s) => !s.current)];
