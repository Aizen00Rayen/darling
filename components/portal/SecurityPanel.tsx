'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import QRCode from 'qrcode';
import { Badge, Button, Field, Notice } from '@/ui';
import { homePathFor, passwordProblem } from '@/shared';
import type { Role } from '@/shared';
import { api } from '@/lib/api/client';
import { apiMessage, fieldErrorsOf } from '@/lib/portal/messages';
import { groupSecret } from '@/lib/portal/totp';

type Props = { role: Role; twoFactorEnabled: boolean; mustEnroll2fa: boolean };

export function SecurityPanel(props: Props) {
  return (
    <div className="p-stack p-stack--lg">
      <PasswordCard />
      <TwoFactorCard {...props} />
    </div>
  );
}

function PasswordCard() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setDone(false);
    const local: Record<string, string> = {};
    if (current === '') local.currentPassword = 'Mot de passe requis.';
    const problem = passwordProblem(next);
    if (problem) local.newPassword = problem;
    if (confirm !== next) local.confirm = 'Les mots de passe ne correspondent pas.';
    setFieldErrors(local);
    if (Object.keys(local).length > 0) return;

    setBusy(true);
    const result = await api('/api/auth/password/change', { method: 'POST', body: { currentPassword: current, newPassword: next } });
    setBusy(false);
    if (!result.ok) {
      const errors = fieldErrorsOf(result);
      if (result.code === 'invalid_credentials') errors.currentPassword = apiMessage('invalid_credentials');
      setFieldErrors(errors);
      if (result.code !== 'validation' && result.code !== 'invalid_credentials') setError(apiMessage(result.code));
      return;
    }
    setCurrent('');
    setNext('');
    setConfirm('');
    setFieldErrors({});
    setDone(true);
  }

  return (
    <section className="p-card glass" aria-labelledby="pw-title">
      <h2 className="p-card__title" id="pw-title">
        Changer le mot de passe
      </h2>
      <form className="p-form" method="post" onSubmit={onSubmit} noValidate>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <div aria-live="polite">
          {done ? (
            <Notice tone="success">
              Mot de passe mis à jour. Vos autres sessions ont été déconnectées.
            </Notice>
          ) : null}
        </div>
        <Field label="Mot de passe actuel" error={fieldErrors.currentPassword}>
          <input type="password" name="currentPassword" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label="Nouveau mot de passe" hint="10 caractères minimum." error={fieldErrors.newPassword}>
          <input type="password" name="newPassword" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label="Confirmer le nouveau mot de passe" error={fieldErrors.confirm}>
          <input type="password" name="confirm" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        <div className="p-form__actions">
          <Button type="submit" busy={busy}>
            Changer le mot de passe
          </Button>
        </div>
      </form>
    </section>
  );
}

type Setup = { qr: string; secret: string };

function TwoFactorCard({ role, twoFactorEnabled, mustEnroll2fa }: Props) {
  const router = useRouter();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  function reset() {
    // The secret and QR live only in this component's state: dropped as soon as they are not needed.
    setSetup(null);
    setPassword('');
    setCode('');
    setFieldErrors({});
  }

  async function start() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setDone(null);
    const result = await api<{ otpauthUrl: string; secret: string }>('/api/auth/2fa/setup', { method: 'POST' });
    if (!result.ok) {
      setBusy(false);
      setError(apiMessage(result.code));
      return;
    }
    try {
      // Generated in the browser: the otpauth URL is never sent to a third party.
      const svg = await QRCode.toString(result.data.otpauthUrl, { type: 'svg', margin: 1, width: 200 });
      setSetup({ qr: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`, secret: result.data.secret });
    } catch {
      setError('Le code QR n’a pas pu être généré. Utilisez la clé de configuration manuelle.');
      setSetup({ qr: '', secret: result.data.secret });
    }
    setBusy(false);
  }

  async function submit(event: FormEvent<HTMLFormElement>, endpoint: 'enable' | 'disable') {
    event.preventDefault();
    if (busy) return;
    setError(null);
    const local: Record<string, string> = {};
    if (password === '') local.password = 'Mot de passe requis.';
    if (!/^\d{6}$/.test(code.trim())) local.code = 'Code à 6 chiffres requis.';
    setFieldErrors(local);
    if (Object.keys(local).length > 0) return;

    setBusy(true);
    const result = await api(`/api/auth/2fa/${endpoint}`, { method: 'POST', body: { password, code: code.trim() } });
    setBusy(false);
    if (!result.ok) {
      const errors = fieldErrorsOf(result);
      if (result.code === 'invalid_credentials') errors.password = apiMessage('invalid_credentials');
      if (result.code === 'totp_invalid') {
        errors.code = apiMessage('totp_invalid');
        setCode('');
      }
      setFieldErrors(errors);
      if (!['validation', 'invalid_credentials', 'totp_invalid'].includes(result.code)) setError(apiMessage(result.code));
      return;
    }
    reset();
    if (endpoint === 'enable' && mustEnroll2fa) {
      // Mandatory enrolment is over. A full navigation: the client router may hold a cached redirect
      // from the portal home back to this page, which a soft navigation would replay.
      window.location.assign(homePathFor(role));
      return;
    }
    setDone(endpoint === 'enable' ? 'Double authentification activée.' : 'Double authentification désactivée.');
    router.refresh();
  }

  return (
    <section className="p-card glass" aria-labelledby="tfa-title">
      <h2 className="p-card__title" id="tfa-title">
        Double authentification
      </h2>
      <p>
        {twoFactorEnabled ? <Badge tone="success">Activée</Badge> : <Badge tone="warning">Désactivée</Badge>}
      </p>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div aria-live="polite">{done ? <Notice tone="success">{done}</Notice> : null}</div>

      {twoFactorEnabled ? (
        <form className="p-form" method="post" onSubmit={(e) => submit(e, 'disable')} noValidate>
          <p className="p-lead">Pour désactiver la double authentification, confirmez votre mot de passe et saisissez un code de votre application.</p>
          <CredentialFields password={password} code={code} setPassword={setPassword} setCode={setCode} errors={fieldErrors} />
          <div className="p-form__actions">
            <Button type="submit" variant="danger" busy={busy}>
              Désactiver
            </Button>
          </div>
        </form>
      ) : setup ? (
        <div className="p-stack">
          <p className="p-lead">
            Scannez ce code QR avec votre application d’authentification (Google Authenticator, Authy, 1Password…), ou saisissez la clé manuellement.
          </p>
          <div className="p-qr">
            {setup.qr ? (
              // eslint-disable-next-line @next/next/no-img-element -- a data: URL generated locally
              <img src={setup.qr} width={200} height={200} alt="Code QR à scanner avec votre application d’authentification" />
            ) : null}
            <div>
              <p className="dl-eyebrow">Clé de configuration manuelle</p>
              <p className="p-secret" aria-label="Clé de configuration">
                {groupSecret(setup.secret)}
              </p>
            </div>
          </div>
          <form className="p-form" method="post" onSubmit={(e) => submit(e, 'enable')} noValidate>
            <CredentialFields password={password} code={code} setPassword={setPassword} setCode={setCode} errors={fieldErrors} />
            <div className="p-form__actions">
              <Button type="submit" busy={busy}>
                Confirmer l’activation
              </Button>
              <Button variant="ghost" disabled={busy} onClick={reset}>
                Annuler
              </Button>
            </div>
          </form>
        </div>
      ) : (
        <div className="p-stack">
          <p className="p-lead">Ajoutez une couche de sécurité : un code temporaire de votre téléphone sera demandé à chaque connexion.</p>
          <div className="p-form__actions">
            <Button busy={busy} onClick={start}>
              Activer
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function CredentialFields(props: {
  password: string;
  code: string;
  setPassword: (v: string) => void;
  setCode: (v: string) => void;
  errors: Record<string, string>;
}) {
  return (
    <div className="p-grid p-grid--2">
      <Field label="Mot de passe actuel" error={props.errors.password}>
        <input type="password" name="password" autoComplete="current-password" value={props.password} onChange={(e) => props.setPassword(e.target.value)} />
      </Field>
      <Field label="Code à 6 chiffres" error={props.errors.code}>
        <input
          type="text"
          name="code"
          autoComplete="one-time-code"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={6}
          value={props.code}
          onChange={(e) => props.setCode(e.target.value)}
        />
      </Field>
    </div>
  );
}
