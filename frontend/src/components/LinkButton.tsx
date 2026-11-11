import type { ReactNode } from "react";

import { Link } from "@/i18n/navigation";

import type { ButtonVariant } from "./Button";
import styles from "./Button.module.css";

export interface LinkButtonProps {
  /** Locale-less path, for example "/sign-in". */
  href: string;
  variant?: ButtonVariant;
  children: ReactNode;
}

/** A link that looks like a Button, for navigation that is not an action. */
export function LinkButton({ href, variant = "primary", children }: LinkButtonProps) {
  return (
    <Link href={href} className={`${styles.button} ${styles[variant]}`} style={{ textDecoration: "none" }}>
      {children}
    </Link>
  );
}
