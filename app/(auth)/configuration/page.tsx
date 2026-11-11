import { Suspense } from 'react';
import type { Metadata } from 'next';
import { SetupGate } from '@/components/auth/SetupGate';

export const metadata: Metadata = { title: 'Configuration — Darling', robots: { index: false }, referrer: 'no-referrer' };

export default function ConfigurationPage() {
  return (
    <Suspense fallback={null}>
      <SetupGate />
    </Suspense>
  );
}
