"use client";

import { useRef } from "react";
import type { KeyboardEvent } from "react";

import styles from "./SegmentedControl.module.css";

export interface SegmentedOption<V extends string> {
  value: V;
  label: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<V extends string> {
  /** Names the group for assistive technology, for example "Currency". */
  label: string;
  options: ReadonlyArray<SegmentedOption<V>>;
  value: V;
  onChange: (value: V) => void;
}

function isRtl(element: HTMLElement): boolean {
  const dir = element.closest("[dir]")?.getAttribute("dir") ?? document.documentElement.getAttribute("dir");
  return dir === "rtl";
}

// A radio group: one tab stop, arrow keys move the selection (reversed in right-to-left).
export function SegmentedControl<V extends string>({ label, options, value, onChange }: SegmentedControlProps<V>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  function move(from: number, step: 1 | -1) {
    for (let i = 1; i <= options.length; i += 1) {
      const index = (from + step * i + options.length * i) % options.length;
      const option = options[index];
      if (option && !option.disabled) {
        onChange(option.value);
        refs.current[index]?.focus();
        return;
      }
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
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
        move(options.length, -1);
        break;
    }
  }

  const selectedIndex = options.findIndex((option) => option.value === value);

  return (
    <div className={styles.seg} role="radiogroup" aria-label={label}>
      {options.map((option, index) => {
        const selected = option.value === value;
        // The selected option is the tab stop; with no valid selection the first enabled one is.
        const tabbable = selected || (selectedIndex === -1 && index === options.findIndex((o) => !o.disabled));
        return (
          <button
            key={option.value}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={tabbable ? 0 : -1}
            disabled={option.disabled}
            className={[styles.option, selected ? styles.on : ""].filter(Boolean).join(" ")}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
