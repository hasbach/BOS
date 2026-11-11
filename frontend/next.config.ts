import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// The browser always talks to the same origin; /api/v1 is forwarded to the Flask API.
// In production a reverse proxy does this instead.
const apiUrl = process.env.BOS_API_INTERNAL_URL ?? "http://localhost:8000";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    return [{ source: "/api/v1/:path*", destination: `${apiUrl}/api/v1/:path*` }];
  },
};

export default withNextIntl(nextConfig);
