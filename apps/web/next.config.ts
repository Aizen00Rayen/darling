import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  transpilePackages: ["@darling/shared"],
  cacheComponents: true,
  partialPrefetching: true,
};

export default nextConfig;
