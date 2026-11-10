'use client';

import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Notice } from '@/ui';
import { PASSWORD_MIN_LENGTH, passwordProblem } from '@/shared';
import { api } from '@/lib/api/client';
import { useHydrated } from '@/lib/auth/use-hydrated';
import { InvalidLink } from './InvalidLink';
import { MESSAGES, messageForCode } from '@/lib/auth/messages';

type Props = {
  mode: 'reset' | 'invite';
  token: string;
  /** Account e-mail, only to let password managers pair the new password with the right login. */
  username?: string;
  title: string;
  lead?: string;
};

export function SetPasswordForm({ mode, token, username, title, lead }: Props) {
  const router = useRouter();
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  // A click before hydration would fall back to a native form submit: stay disabled until mounted.
  const ready = useHydrated();
  const [invalid, setInvalid] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<{ password?: string; confirm?: string }>({});

  if (invalid) return <InvalidLink title={title} />;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setErrors({});

    const problem = passwordProblem(password);
    if (problem) {
      setErrors({ password: problem });
      passwordRef.current?.focus();
      return;
    }
    if (password !== confirm) {
      setErrors({ confirm: MESSAGES.mismatch });
      confirmRef.current?.focus();
      return;
    }

    setBusy(true);
    const path = mode === 'reset' ? '/api/auth/password/reset' : '/api/auth/invite/accept';
    const result = await api<void>(path, { method: 'POST', body: { token, password } });
    if (result.ok) {
      router.replace(mode === 'reset' ? '/connexion?reset=1' : '/connexion?invited=1');
      return; // stay busy while navigating
    }

    setBusy(false);
    if (result.code === 'invalid_token') {
      setInvalid(true);
    } else if (result.code === 'validation') {
      setErrors({ password: result.errors?.password ?? MESSAGES.generic });
      passwordRef.current?.focus();
    } else {
      setError(messageForCode(result.code));
    }
  }

  return (
    <>
      <h1 className="auth-title">{title}</h1>
      {lead ? <p className="auth-lead">{lead}</p> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <form className="auth-form" method="post" onSubmit={onSubmit} noValidate>
        {username ? (
          <input type="text" className="auth-sr-only" name="username" autoComplete="username" value={username} readOnly tabIndex={-1} aria-hidden="true" />
        ) : null}
        <Field label="Nouveau mot de passe" hint={`Au moins ${PASSWORD_MIN_LENGTH} caractères.`} error={errors.password}>
          <input
            ref={passwordRef}
            type="password"
            name="new-password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label="Confirmer le mot de passe" error={errors.confirm}>
          <input
            ref={confirmRef}
            type="password"
            name="confirm-password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
        <Button type="submit" busy={busy} disabled={!ready}>
          {mode === 'reset' ? 'Mettre à jour' : 'Activer mon compte'}
        </Button>
      </form>
    </>
  );
}
