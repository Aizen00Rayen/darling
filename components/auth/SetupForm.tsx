'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Notice } from '@/ui';
import { emailSchema, PASSWORD_MIN_LENGTH, passwordProblem } from '@/shared';
import { api } from '@/lib/api/client';
import { useHydrated } from '@/lib/auth/use-hydrated';
import { MESSAGES, messageForCode } from '@/lib/auth/messages';

type Errors = { token?: string; fullName?: string; email?: string; password?: string; confirm?: string };

/** One-time creation of the first owner (the page exists only while no user does). */
export function SetupForm() {
  const router = useRouter();
  const [token, setToken] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  // A click before hydration would fall back to a native form submit: stay disabled until mounted.
  const ready = useHydrated();
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Errors>({});

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setErrors({});

    const local: Errors = {};
    if (token.trim() === '') local.token = 'Jeton de configuration requis.';
    if (fullName.trim().length < 2) local.fullName = 'Le nom est requis.';
    const parsedEmail = emailSchema.safeParse(email);
    if (!parsedEmail.success) local.email = parsedEmail.error.issues[0]?.message ?? 'Adresse e-mail invalide.';
    const problem = passwordProblem(password);
    if (problem) local.password = problem;
    else if (password !== confirm) local.confirm = MESSAGES.mismatch;
    if (Object.keys(local).length > 0) {
      setErrors(local);
      return;
    }

    setBusy(true);
    const result = await api<void>('/api/setup', {
      method: 'POST',
      body: { token: token.trim(), fullName: fullName.trim(), email: parsedEmail.success ? parsedEmail.data : email, password },
    });
    if (result.ok) {
      router.replace('/connexion?setup=1');
      return; // stay busy while navigating
    }
    setBusy(false);
    if (result.code === 'validation' && result.errors) {
      setErrors({ ...(result.errors.token ? { token: result.errors.token } : {}), ...(result.errors.fullName ? { fullName: result.errors.fullName } : {}), ...(result.errors.email ? { email: result.errors.email } : {}), ...(result.errors.password ? { password: result.errors.password } : {}) });
    } else if (result.code === 'not_found') {
      router.replace('/connexion');
    } else {
      setError(messageForCode(result.code));
    }
  }

  return (
    <>
      <h1 className="auth-title">Configuration initiale</h1>
      <p className="auth-lead">
        Créez le compte propriétaire. Cette page n’existe que tant qu’aucun compte n’a été créé et que le jeton de configuration est défini sur le serveur.
      </p>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <form className="auth-form" method="post" onSubmit={onSubmit} noValidate>
        <Field label="Jeton de configuration" hint="La valeur de SETUP_TOKEN définie sur le serveur." error={errors.token}>
          <input type="password" name="setup-token" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} />
        </Field>
        <Field label="Nom complet" error={errors.fullName}>
          <input type="text" name="fullName" autoComplete="name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </Field>
        <Field label="Adresse e-mail" error={errors.email}>
          <input type="email" name="email" autoComplete="username" inputMode="email" autoCapitalize="none" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Mot de passe" hint={`Au moins ${PASSWORD_MIN_LENGTH} caractères.`} error={errors.password}>
          <input type="password" name="new-password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="Confirmer le mot de passe" error={errors.confirm}>
          <input type="password" name="confirm-password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        <Button type="submit" busy={busy} disabled={!ready}>
          Créer le compte propriétaire
        </Button>
      </form>
    </>
  );
}
