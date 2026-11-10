'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api/client';
import { apiMessage } from '@/lib/portal/messages';

/** Logout is a POST (a GET link could be triggered cross-site); then back to the login page. */
export function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function logout() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await api('/api/auth/logout', { method: 'POST' });
    if (!result.ok && result.status !== 401) {
      setBusy(false);
      setError(apiMessage(result.code));
      return;
    }
    router.replace('/connexion');
    router.refresh();
  }

  return (
    <>
      <button type="button" className="dl-user__logout" onClick={logout} disabled={busy} aria-busy={busy || undefined}>
        Se déconnecter
      </button>
      {error ? (
        <p className="dl-field__error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
