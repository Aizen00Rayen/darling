'use client';

import { useEffect, useRef } from 'react';
import { api } from '@/lib/api/client';

/** `AYA001`: the shape of an influenceuse code (the server validates it again). */
const CODE = /^[A-Z]{3}\d{3,}$/;

/**
 * Invisible: reads `?ref=CODE` once, tells the server (which records the click and sets the signed `dl_ref` cookie),
 * then removes `ref` from the address bar so a shared or bookmarked URL does not carry it around. It renders nothing,
 * so the storefront looks exactly the same; a failure is silent (the visitor just is not attributed).
 */
export function RefCapture() {
  // React strict mode runs effects twice in development: the click is reported once per mounted component.
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    const url = new URL(window.location.href);
    const raw = url.searchParams.get('ref');
    if (raw === null) return;
    url.searchParams.delete('ref');
    const clean = `${url.pathname}${url.search}${url.hash}`;
    const code = raw.trim().toUpperCase();
    const forget = () => window.history.replaceState(window.history.state, '', clean);
    if (!CODE.test(code)) {
      forget();
      return;
    }
    void api('/api/affiliate/click', { method: 'POST', body: { code, landingPath: window.location.pathname, referrer: document.referrer.slice(0, 512) } }).finally(forget);
  }, []);
  return null;
}
