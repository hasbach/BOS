import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "BOS — Beta Orders Solutions",
  description: "Social Commerce & Order Management Platform",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

// Phase 1 placeholder. The localized layout (lang/dir, fonts, design tokens) replaces this
// in Phase 2 (task T028).
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
