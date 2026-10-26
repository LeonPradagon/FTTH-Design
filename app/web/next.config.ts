import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  output: "standalone",
  turbopack: { root: path.resolve(process.cwd(), "..") },
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
