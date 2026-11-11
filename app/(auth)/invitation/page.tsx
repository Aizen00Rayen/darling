import { Suspense } from 'react';
import { connection } from 'next/server';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Notice } from '@/ui';
import { InvalidLink } from '@/components/auth/InvalidLink';
import { SetPasswordForm } from '@/components/auth/SetPasswordForm';
import { getServerContext } from '@/server/context';
import { lookupInvitation } from '@/server/auth/recovery';
import { logError } from '@/server/log';
import { MESSAGES } from '@/lib/auth/messages';

// Same format the API issues; checked before the token is put into an API path.
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

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
  if (!TOKEN_FORMAT.test(token)) return <InvalidLink title={title} />;

  await connection(); // request-time data: the lookup reads the clock and the database
  let invite: { email: string; fullName: string } | null;
  try {
    invite = lookupInvitation(getServerContext(), token);
  } catch (err) {
    logError('invitation.lookup_failed', err);
    return (
      <>
        <h1 className="auth-title">{title}</h1>
        <Notice tone="error">{MESSAGES.generic}</Notice>
        <div className="auth-links">
          <Link href={`/invitation?token=${token}`}>Réessayer</Link>
        </div>
      </>
    );
  }
  if (!invite) return <InvalidLink title={title} />;
  return (
    <SetPasswordForm
      mode="invite"
      token={token}
      username={invite.email}
      title={`Bienvenue, ${invite.fullName}`}
      lead="Choisissez un mot de passe pour activer votre compte."
    />
  );
}
