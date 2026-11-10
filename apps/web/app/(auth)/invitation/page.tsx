import { Suspense } from 'react';
import type { Metadata } from 'next';
import { InvalidLink } from '@/components/auth/InvalidLink';
import { SetPasswordForm } from '@/components/auth/SetPasswordForm';
import { apiServer } from '@/lib/api/server';

export const metadata: Metadata = {
  title: 'Invitation — Darling',
  robots: { index: false },
  referrer: 'no-referrer',
};

export default function InvitationPage({ searchParams }: PageProps<'/invitation'>) {
  return (
    <Suspense fallback={null}>
      <Content searchParams={searchParams} />
    </Suspense>
  );
}

async function Content({ searchParams }: { searchParams: PageProps<'/invitation'>['searchParams'] }) {
  const sp = await searchParams;
  const token = typeof sp.token === 'string' ? sp.token : '';
  const title = 'Activer mon compte';
  if (!token) return <InvalidLink title={title} />;

  const res = await apiServer<{ email: string; fullName: string }>(`/api/auth/invite/${encodeURIComponent(token)}`);
  if (!res.ok) {
    // 404 means unknown/used/expired; anything else (API down) is also not actionable for the visitor.
    return <InvalidLink title={title} />;
  }
  return (
    <SetPasswordForm
      mode="invite"
      token={token}
      username={res.data.email}
      title={`Bienvenue, ${res.data.fullName}`}
      lead="Choisissez un mot de passe pour activer votre compte."
    />
  );
}
