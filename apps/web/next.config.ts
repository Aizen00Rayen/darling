import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  transpilePackages: ["@darling/shared", "@darling/ui"],
  cacheComponents: true,
  partialPrefetching: true,
};

export default nextConfig;
