import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "jsdom",
    // next-intl imports "next/navigation" without an extension; let Vite resolve it.
    server: { deps: { inline: ["next-intl"] } },
    include: ["tests/**/*.test.{ts,tsx}"],
    setupFiles: ["./tests/setup.ts"],
    // Generous so a busy machine cannot fail a test that is only slow; a passing test is not slower.
    testTimeout: 20000,
  },
});
