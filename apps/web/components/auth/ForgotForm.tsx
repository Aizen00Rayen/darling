'use client';

import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import Link from 'next/link';
import { Button, Field, Notice } from '@darling/ui';
import { emailSchema } from '@darling/shared';
import { api } from '@/lib/api/client';
import { useHydrated } from '@/lib/auth/use-hydrated';
import { MESSAGES, messageForCode } from '@/lib/auth/messages';

export function ForgotForm() {
  const emailRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  // A click before hydration would fall back to a native form submit: stay disabled until mounted.
  const ready = useHydrated();
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setFieldError(undefined);

    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? 'Adresse e-mail invalide.');
      emailRef.current?.focus();
      return;
    }

    setBusy(true);
    const result = await api<void>('/api/auth/password/forgot', { method: 'POST', body: { email: parsed.data } });
    setBusy(false);
    if (result.ok) {
      setSent(true);
      return;
    }
    setError(messageForCode(result.code));
  }

  return (
    <>
      <h1 className="auth-title">Mot de passe oublié</h1>
      {sent ? (
        <>
          <Notice tone="success">{MESSAGES.forgotNeutral}</Notice>
          <div className="auth-links">
            <Link href="/connexion">Retour à la connexion</Link>
          </div>
        </>
      ) : (
        <>
          <p className="auth-lead">Saisissez votre adresse e-mail : nous vous enverrons un lien pour choisir un nouveau mot de passe.</p>
          {error ? <Notice tone="error">{error}</Notice> : null}
          <form className="auth-form" method="post" onSubmit={onSubmit} noValidate>
            <Field label="Adresse e-mail" error={fieldError}>
              <input
                ref={emailRef}
                type="email"
                name="email"
                autoComplete="email"
                inputMode="email"
                autoCapitalize="none"
                spellCheck={false}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Button type="submit" busy={busy} disabled={!ready}>
              Envoyer le lien
            </Button>
          </form>
          <div className="auth-links">
            <Link href="/connexion">Retour à la connexion</Link>
          </div>
        </>
      )}
    </>
  );
}
