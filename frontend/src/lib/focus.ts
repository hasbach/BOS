"use client";

import { useEffect, useRef, useState } from "react";

/**
 * For forms whose field errors have no summary banner: after a submit that left a field invalid, moves
 * focus to the first invalid field, so a screen reader reads its label and its error (linked by
 * aria-describedby) and keyboard users land where the fix is. Call `flagInvalid()` on such a submit.
 */
export function useFocusFirstInvalid<T extends HTMLElement = HTMLFormElement>() {
  const formRef = useRef<T>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (attempt === 0) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [attempt]);

  return { formRef, flagInvalid: () => setAttempt((count) => count + 1) };
}
