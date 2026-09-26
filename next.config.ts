import type { NextConfig } from "next";

// Sites allowed to show the embeddable 360° viewer (/embed/…) in an iframe,
// e.g. the Sun Sport Squarespace product pages.
const EMBED_ANCESTORS = [
  "'self'",
  "https://sunsportmarineinc.com",
  "https://www.sunsportmarineinc.com",
  "https://*.squarespace.com",
  // Local testing of the embed snippet.
  ...(process.env.NODE_ENV === "development" ? ["http://localhost:*", "http://127.0.0.1:*"] : []),
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/embed/:path*",
        headers: [{ key: "Content-Security-Policy", value: `frame-ancestors ${EMBED_ANCESTORS.join(" ")}` }],
      },
    ];
  },
};

export default nextConfig;
