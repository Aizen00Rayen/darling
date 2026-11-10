import Link from 'next/link';
import { Notice } from '@/ui';
import { MESSAGES } from '@/lib/auth/messages';

export function InvalidLink({ title }: { title: string }) {
  return (
    <>
      <h1 className="auth-title">{title}</h1>
      <Notice tone="error">{MESSAGES.invalidLink}</Notice>
      <div className="auth-links">
        <Link href="/mot-de-passe-oublie">Demander un nouveau lien</Link>
      </div>
    </>
  );
}
