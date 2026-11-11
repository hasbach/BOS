import type { ReactNode } from "react";

import styles from "./Chip.module.css";

export type ChipTone = "neutral" | "ok" | "warn" | "bad" | "info" | "storeA" | "storeB";

export interface ChipProps {
  tone?: ChipTone;
  /** Status is always written out; colour only reinforces it. */
  children: ReactNode;
  className?: string;
}

export function Chip({ tone = "neutral", children, className }: ChipProps) {
  return <span className={[styles.chip, styles[tone], className ?? ""].filter(Boolean).join(" ")}>{children}</span>;
}
