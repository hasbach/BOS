"use client";

import { useEffect } from "react";

/**
 * Registers the minimal service worker (public/sw.js) in production builds only, so `next dev` and
 * the end-to-end tests never run with a worker in the way. The worker keeps static shell files and
 * never the API.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {
      // No worker: BOS works as a normal web page.
    });
  }, []);
  return null;
}
