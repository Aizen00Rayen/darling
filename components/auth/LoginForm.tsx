'use client';

import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Field, Notice } from '@/ui';
import { emailSchema, homePathFor, meSchema } from '@/shared';
import { api } from '@/lib/api/client';
import { useHydrated } from '@/lib/auth/use-hydrated';
import { safeNextPath } from '@/lib/auth/next-path';
import { MESSAGES, messageForCode } from '@/lib/auth/messages';

type Props = { next: string | null; notice: 'reset' | 'invited' | 'setup' | null };

export function LoginForm({ next, notice }: Props) {
  const router = useRouter();
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'credentials' | 'code'>('credentials');
  const [busy, setBusy] = useState(false);
  // A click before hydration would fall back to a native form submit: stay disabled until mounted.
  const ready = useHydrated();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string; code?: string }>({});

  function back() {
    setStep('credentials');
    setCode('');
    setError(null);
    setFieldErrors({});
    setPassword('');
    setTimeout(() => passwordRef.current?.focus(), 0);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setFieldErrors({});

    if (step === 'credentials') {
      const parsed = emailSchema.safeParse(email);
      if (!parsed.success) {
        setFieldErrors({ email: parsed.error.issues[0]?.message ?? 'Adresse e-mail invalide.' });
        emailRef.current?.focus();
        return;
      }
      if (password.length === 0) {
        setFieldErrors({ password: 'Mot de passe requis.' });
        passwordRef.current?.focus();
        return;
      }
    } else if (code.trim().length === 0) {
      setFieldErrors({ code: 'Code à 6 chiffres requis.' });
      codeRef.current?.focus();
      return;
    }

    setBusy(true);
    const result = await api<{ user: unknown }>('/api/auth/login', {
      method: 'POST',
      body: {
        email,
        password,
        remember,
        ...(step === 'code' ? { totpCode: code.trim() } : {}),
      },
    });

    if (result.ok) {
      const me = meSchema.safeParse(result.data?.user);
      if (!me.success) {
        setBusy(false);
        setError(MESSAGES.generic);
        return;
      }
      router.replace(safeNextPath(next, homePathFor(me.data.role)));
      router.refresh();
      return; // stay busy while navigating: no double submit
    }

    setBusy(false);
    if (result.code === 'totp_required') {
      setStep('code');
      setTimeout(() => codeRef.current?.focus(), 0);
      return;
    }
    setError(messageForCode(result.code));
    if (result.code === 'totp_invalid') {
      setCode('');
      setTimeout(() => codeRef.current?.focus(), 0);
    } else if (result.code === 'invalid_credentials') {
      setPassword('');
      setTimeout(() => passwordRef.current?.focus(), 0);
    }
  }

  return (
    <>
      <h1 className="auth-title">Connexion</h1>
      {notice === 'reset' ? <Notice tone="success">{MESSAGES.resetDone}</Notice> : null}
      {notice === 'setup' ? <Notice tone="success">{MESSAGES.setupDone}</Notice> : null}
      {notice === 'invited' ? <Notice tone="success">{MESSAGES.inviteDone}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <form className="auth-form" method="post" onSubmit={onSubmit} noValidate>
        {step === 'credentials' ? (
          <>
            <Field label="Adresse e-mail" error={fieldErrors.email}>
              <input
                ref={emailRef}
                type="email"
                name="email"
                autoComplete="username"
                inputMode="email"
                autoCapitalize="none"
                spellCheck={false}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field label="Mot de passe" error={fieldErrors.password}>
              <input
                ref={passwordRef}
                type="password"
                name="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <label className="auth-check">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              Rester connectée
            </label>
          </>
        ) : (
          <Field label="Code de vérification" hint={MESSAGES.totpHint} error={fieldErrors.code}>
            <input
              ref={codeRef}
              type="text"
              name="totpCode"
              autoComplete="one-time-code"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={12}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </Field>
        )}
        <Button type="submit" busy={busy} disabled={!ready}>
          {step === 'credentials' ? 'Se connecter' : 'Valider'}
        </Button>
      </form>
      <div className="auth-links">
        {step === 'code' ? (
          <button type="button" className="auth-link" onClick={back}>
            Retour
          </button>
        ) : (
          <Link href="/mot-de-passe-oublie">Mot de passe oublié ?</Link>
        )}
      </div>
    </>
  );
}
