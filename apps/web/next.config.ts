import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvConfig } from '@next/env';
import type { NextConfig } from 'next';

// The repo keeps a single .env at the root; Next only reads .env* inside apps/web. Only APP_ORIGIN,
// API_INTERNAL_URL and COOKIE_SECURE are used by the web app; nothing is exposed with NEXT_PUBLIC_.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const isDev = process.env.NODE_ENV !== 'production';
// forceReload: Next has usually loaded apps/web/.env* already and would return that cached result.
loadEnvConfig(repoRoot, isDev, console, true);

const apiInternalUrl = (process.env.API_INTERNAL_URL ?? 'http://localhost:4000').replace(/\/+$/, '');
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
  transpilePackages: ['@darling/shared', '@darling/ui'],
  cacheComponents: true,
  partialPrefetching: true,
  async rewrites() {
    // afterFiles: the storefront's own filesystem routes (app/api/orders) win; everything else under
    // /api is proxied to the Fastify API.
    return { afterFiles: [{ source: '/api/:path*', destination: `${apiInternalUrl}/api/:path*` }] };
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
