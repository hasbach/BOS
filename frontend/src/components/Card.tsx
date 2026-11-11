import type { HTMLAttributes } from "react";

import styles from "./Card.module.css";

export interface CardProps extends HTMLAttributes<HTMLElement> {
  as?: "div" | "section" | "article";
}

export function Card({ as: Tag = "div", className, ...rest }: CardProps) {
  return <Tag {...rest} className={[styles.card, className ?? ""].filter(Boolean).join(" ")} />;
}
