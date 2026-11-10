import { Suspense } from 'react';
import { PageLoading } from '@/components/portal/PageLoading';
import type { Metadata } from 'next';
import { PageHeader } from '@/ui';
import { SecurityPanel } from '@/components/portal/SecurityPanel';
import { requireAccount } from '@/lib/portal/guards';

export const metadata: Metadata = { title: 'Sécurité du compte — Darling', robots: { index: false } };

export default function SecuritePage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  const me = await requireAccount();
  return (
    <div className="p-stack p-stack--lg">
      <PageHeader eyebrow="Mon compte" title="Sécurité" />
      <SecurityPanel role={me.role} twoFactorEnabled={me.twoFactorEnabled} mustEnroll2fa={me.mustEnroll2fa} />
    </div>
  );
}
