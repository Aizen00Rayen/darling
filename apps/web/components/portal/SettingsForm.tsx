'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Notice } from '@darling/ui';
import { SETTINGS } from '@darling/shared';
import type { SettingKey } from '@darling/shared';
import { api } from '@/lib/api/client';
import { apiMessage } from '@/lib/portal/messages';

type Values = { 'security.require_2fa_super_managers': boolean; 'company.name': string };

const KEYS = Object.keys(SETTINGS) as SettingKey[];

export function SettingsForm({ initial }: { initial: Values }) {
  return (
    <div className="p-stack">
      {KEYS.map((key) => (
        <SettingCard key={key} settingKey={key} initial={initial[key]} />
      ))}
    </div>
  );
}

function SettingCard({ settingKey, initial }: { settingKey: SettingKey; initial: boolean | string }) {
  const router = useRouter();
  const [value, setValue] = useState<boolean | string>(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  async function save() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const result = await api(`/api/settings/${settingKey}`, { method: 'PATCH', body: { value } });
    setBusy(false);
    if (!result.ok) {
      const detail = result.errors ? Object.values(result.errors)[0] : undefined;
      setMessage({ tone: 'error', text: detail ?? apiMessage(result.code) });
      return;
    }
    setMessage({ tone: 'success', text: 'Paramètre enregistré.' });
    router.refresh();
  }

  const isToggle = settingKey === 'security.require_2fa_super_managers';
  return (
    <section className="p-card glass" aria-labelledby={`s-${settingKey}`}>
      <h2 className="p-card__title" id={`s-${settingKey}`}>
        {isToggle ? 'Double authentification obligatoire pour les Super Managers' : 'Nom de l’entreprise'}
      </h2>
      {isToggle ? (
        <>
          <p className="p-lead">Les Super Managers sans double authentification seront invités à l’activer à leur prochaine connexion.</p>
          <label className="p-switch">
            <input
              type="checkbox"
              role="switch"
              checked={value === true}
              onChange={(e) => setValue(e.target.checked)}
              aria-label="Double authentification obligatoire pour les Super Managers"
            />
            <span>{value === true ? 'Activée' : 'Désactivée'}</span>
          </label>
        </>
      ) : (
        <Field label="Nom de l’entreprise">
          <input type="text" maxLength={100} value={String(value)} onChange={(e) => setValue(e.target.value)} />
        </Field>
      )}
      <div aria-live="polite">{message ? <Notice tone={message.tone}>{message.text}</Notice> : null}</div>
      <div className="p-form__actions">
        <Button busy={busy} onClick={save}>
          Enregistrer
        </Button>
      </div>
    </section>
  );
}
