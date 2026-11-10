import { Suspense } from 'react';
import type { Metadata } from 'next';
import { InvalidLink } from '@/components/auth/InvalidLink';
import { SetPasswordForm } from '@/components/auth/SetPasswordForm';

export const metadata: Metadata = { title: 'Nouveau mot de passe — Darling', robots: { index: false } };

export default function ReinitialiserPage({ searchParams }: PageProps<'/reinitialiser'>) {
  return (
    <Suspense fallback={null}>
      <Content searchParams={searchParams} />
    </Suspense>
  );
}

async function Content({ searchParams }: { searchParams: PageProps<'/reinitialiser'>['searchParams'] }) {
  const sp = await searchParams;
  const token = typeof sp.token === 'string' ? sp.token : '';
  const title = 'Nouveau mot de passe';
  if (!token) return <InvalidLink title={title} />;
  return <SetPasswordForm mode="reset" token={token} title={title} />;
}
