"use client";

import { useEffect, useRef, useState } from "react";

// One-time link tokens travel in the URL fragment (research R26): browsers never send it to a
// server. After reading it the page removes it from the address bar so it is not left in history.

/** Reads the token from `location.hash` and removes the fragment from the address bar. */
export function takeFragmentToken(): string | null {
  const raw = window.location.hash.replace(/^#/, "").trim();
  if (raw !== "") {
    window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  }
  return raw === "" ? null : raw;
}

export interface FragmentToken {
  /** False until the browser has been asked; the server render never knows the fragment. */
  ready: boolean;
  token: string | null;
}

export function useFragmentToken(): FragmentToken {
  const [state, setState] = useState<FragmentToken>({ ready: false, token: null });
  // React runs effects twice in development; the fragment can only be taken once.
  const taken = useRef(false);

  useEffect(() => {
    if (taken.current) return;
    taken.current = true;
    setState({ ready: true, token: takeFragmentToken() });
  }, []);

  return state;
}
