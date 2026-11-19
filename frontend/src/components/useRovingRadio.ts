"use client";

import { useRef } from "react";
import type { KeyboardEvent } from "react";

function isRtl(element: HTMLElement): boolean {
  const dir = element.closest("[dir]")?.getAttribute("dir") ?? document.documentElement.getAttribute("dir");
  return dir === "rtl";
}

export interface RovingRadioItem {
  ref: (node: HTMLElement | null) => void;
  tabIndex: 0 | -1;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

/**
 * Keyboard behaviour for a `role="radiogroup"` made of `role="radio"` buttons (same rules as
 * SegmentedControl): one Tab stop (the selected radio, or the first one when none in this group is
 * selected), arrow keys move the selection and the focus with wrap-around, Home and End jump to
 * the first and last. Left and Right follow the reading direction, so they swap in right-to-left;
 * Up and Down always mean next and previous.
 *
 * `values` lists the group's radios in order. `value` is the selected one (or a value that is not in
 * this group). Spread `item(value)` on each radio next to its own `onClick`.
 */
export function useRovingRadio<V extends string>(values: readonly V[], value: string | null, onChange: (value: V) => void): (value: V) => RovingRadioItem {
  const nodes = useRef(new Map<V, HTMLElement>());

  function move(from: number, step: 1 | -1) {
    const count = values.length;
    if (count === 0) return;
    const index = (((from + step) % count) + count) % count;
    const next = values[index];
    if (next === undefined) return;
    onChange(next);
    nodes.current.get(next)?.focus();
  }

  const selected = values.findIndex((v) => v === value);
  const tabStop = selected === -1 ? 0 : selected;

  return (radio: V): RovingRadioItem => {
    const index = values.indexOf(radio);
    return {
      ref: (node) => {
        if (node) nodes.current.set(radio, node);
        else nodes.current.delete(radio);
      },
      tabIndex: index === tabStop ? 0 : -1,
      onKeyDown: (event) => {
        const rtl = isRtl(event.currentTarget);
        switch (event.key) {
          case "ArrowRight":
            event.preventDefault();
            move(index, rtl ? -1 : 1);
            break;
          case "ArrowLeft":
            event.preventDefault();
            move(index, rtl ? 1 : -1);
            break;
          case "ArrowDown":
            event.preventDefault();
            move(index, 1);
            break;
          case "ArrowUp":
            event.preventDefault();
            move(index, -1);
            break;
          case "Home":
            event.preventDefault();
            move(-1, 1);
            break;
          case "End":
            event.preventDefault();
            move(values.length, -1);
            break;
        }
      },
    };
  };
}
