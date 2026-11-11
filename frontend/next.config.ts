import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// The browser always talks to the same origin; /api/v1 is forwarded to the Flask API.
// In production a reverse proxy does this instead.
// The default is the BOS API run directly on this computer (port 5100). It must never be a
// port that other software uses: on the development PC, 8000 belongs to another application,
// and forwarding there would send BOS passwords and link tokens to it. Docker Compose sets
// BOS_API_INTERNAL_URL=http://api:8000 inside its own network.
const apiUrl = process.env.BOS_API_INTERNAL_URL ?? "http://127.0.0.1:5100";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  // The end-to-end tests run their own server beside the development one and need their own folder.
  distDir: process.env.BOS_NEXT_DIST_DIR ?? ".next",
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    return [{ source: "/api/v1/:path*", destination: `${apiUrl}/api/v1/:path*` }];
  },
};

export default withNextIntl(nextConfig);
