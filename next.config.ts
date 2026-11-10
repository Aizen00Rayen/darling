import type { NextConfig } from 'next';

// One app at the repository root: Next loads .env* from here. Nothing is exposed with NEXT_PUBLIC_.
const isDev = process.env.NODE_ENV !== 'production';
const secureCookies = process.env.COOKIE_SECURE === 'true';

// Report-only for now; enforced in sub-project 8 once nonce support is checked against the storefront.
// next/font/google self-hosts the fonts at build time, so no external font origin is needed.
const csp = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  `connect-src 'self'${isDev ? ' ws: wss:' : ''}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  ...(secureCookies ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }] : []),
  { key: 'Content-Security-Policy-Report-Only', value: csp },
];

const nextConfig: NextConfig = {
  transpilePackages: ['@/shared', '@/ui'],
  // Loaded lazily at runtime by server/db/sqlite.ts only when node:sqlite is unavailable.
  serverExternalPackages: ['better-sqlite3'],
  cacheComponents: true,
  partialPrefetching: true,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
