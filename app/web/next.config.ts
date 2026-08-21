import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  async rewrites() {
    return [
      {
        source: "/data/:path*",
        destination: "/api/proxy/data/:path*",
      },
    ];
  },
};

export default nextConfig;
