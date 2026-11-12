"use client";

import { useEffect } from "react";

import { Loading } from "@/components/Loading";
import { useRouter } from "@/i18n/navigation";
import { useMe } from "@/lib/session";
import { isTabKey, tabPath } from "@/lib/tabs";

/** Entry to the app: opens the tab the server chose in GET /me (`start_tab`). */
export function StartRedirect() {
  const router = useRouter();
  const { start_tab: start } = useMe();

  useEffect(() => {
    router.replace(isTabKey(start) ? tabPath(start) : "/more");
  }, [router, start]);

  return <Loading />;
}
