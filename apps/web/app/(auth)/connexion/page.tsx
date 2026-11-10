import { Suspense } from 'react';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { homePathFor } from '@darling/shared';
import { LoginForm } from '@/components/auth/LoginForm';
import { getMe } from '@/lib/auth/session';

export const metadata: Metadata = { title: 'Connexion — Darling', robots: { index: false } };

export default function ConnexionPage({ searchParams }: PageProps<'/connexion'>) {
  return (
    <Suspense fallback={null}>
      <Content searchParams={searchParams} />
    </Suspense>
  );
}

async function Content({ searchParams }: { searchParams: PageProps<'/connexion'>['searchParams'] }) {
  const sp = await searchParams;
  const me = await getMe();
  if (me) redirect(homePathFor(me.role));

  const next = typeof sp.next === 'string' ? sp.next : null;
  const notice = sp.reset === '1' ? 'reset' : sp.invited === '1' ? 'invited' : null;
  return <LoginForm next={next} notice={notice} />;
}
