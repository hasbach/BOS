"use client";

import type { ReactNode } from "react";

import { usePathname } from "@/i18n/navigation";
import { showsTabBar } from "@/lib/tabs";

import { BottomNav } from "./BottomNav";
import { InstallCard } from "./InstallCard";
import { OfflineNotice } from "./OfflineNotice";
import styles from "./AppShell.module.css";

/**
 * The frame around every signed-in screen: the no-connection notice on top (screen 129), the
 * screen itself, and on the tab screens the install card and the bottom tab bar.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const tabs = showsTabBar(pathname);

  return (
    <div className={styles.frame}>
      <div className={styles.notice}>
        <OfflineNotice />
      </div>
      <div className={styles.content}>{children}</div>
      {tabs ? (
        <>
          <div className={styles.install}>
            <InstallCard />
          </div>
          <BottomNav />
        </>
      ) : null}
    </div>
  );
}
