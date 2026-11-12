'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Notice } from '@/ui';
import { SETTINGS, isOwnerOnlySetting } from '@/shared';
import type { SettingKey } from '@/shared';
import { api } from '@/lib/api/client';
import { apiMessage } from '@/lib/portal/messages';

export type SettingValues = {
  'security.require_2fa_super_managers': boolean;
  'company.name': string;
  'commission.affiliate_amount': number;
  'commission.manager_amount': number;
  'attribution.window_days': number;
};

const KEYS = Object.keys(SETTINGS) as SettingKey[];

type NumberSpec = { label: string; hint: string; min: number; max: number };
/** French labels of the numeric settings (whole numbers, owner-only). */
export const NUMBER_SETTINGS: Partial<Record<SettingKey, NumberSpec>> = {
  'commission.affiliate_amount': { label: 'Commission de l’influenceuse (DA)', hint: 'Montant par article vendu dans chaque commande livrée (ex : 3 articles = 3 × ce montant). Figé à la création de la commande.', min: 0, max: 100_000 },
  'commission.manager_amount': { label: 'Commission du sous-manager (DA)', hint: 'Montant par article vendu par son équipe dans chaque commande livrée.', min: 0, max: 100_000 },
  'attribution.window_days': { label: 'Durée d’attribution (jours)', hint: 'Une commande est attribuée à une influenceuse si le clic sur son lien date de moins de ce nombre de jours.', min: 1, max: 365 },
};

export function SettingsForm({ initial, isOwner = false }: { initial: SettingValues; isOwner?: boolean }) {
  return (
    <div className="p-stack">
      {KEYS.map((key) => (
        <SettingCard key={key} settingKey={key} initial={initial[key]} locked={isOwnerOnlySetting(key) && !isOwner} />
      ))}
    </div>
  );
}

function SettingCard({ settingKey, initial, locked }: { settingKey: SettingKey; initial: boolean | string | number; locked: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState<boolean | string>(typeof initial === 'number' ? String(initial) : initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const number = NUMBER_SETTINGS[settingKey];

  async function save() {
    if (busy || locked) return;
    let body: boolean | string | number = value;
    if (number) {
      const text = String(value).trim();
      if (!/^\d{1,7}$/.test(text)) {
        setMessage({ tone: 'error', text: 'Saisissez un nombre entier.' });
        return;
      }
      body = Number(text);
    }
    setBusy(true);
    setMessage(null);
    const result = await api(`/api/settings/${settingKey}`, { method: 'PATCH', body: { value: body } });
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
  const title = number ? number.label : isToggle ? 'Double authentification obligatoire pour les Super Managers' : 'Nom de l’entreprise';
  return (
    <section className="p-card glass" aria-labelledby={`s-${settingKey}`}>
      <h2 className="p-card__title" id={`s-${settingKey}`}>
        {title}
      </h2>
      {isToggle ? (
        <>
          <p className="p-lead">Les Super Managers sans double authentification seront invités à l’activer à leur prochaine connexion.</p>
          <label className="p-switch">
            <input
              type="checkbox"
              role="switch"
              checked={value === true}
              disabled={locked}
              onChange={(e) => setValue(e.target.checked)}
              aria-label="Double authentification obligatoire pour les Super Managers"
            />
            <span>{value === true ? 'Activée' : 'Désactivée'}</span>
          </label>
        </>
      ) : number ? (
        <Field label={number.label} hint={number.hint}>
          <input type="number" inputMode="numeric" step={1} min={number.min} max={number.max} name={settingKey} value={String(value)} disabled={locked} onChange={(e) => setValue(e.target.value)} />
        </Field>
      ) : (
        <Field label="Nom de l’entreprise">
          <input type="text" maxLength={100} value={String(value)} onChange={(e) => setValue(e.target.value)} />
        </Field>
      )}
      {locked ? <p className="p-lead">Seul un propriétaire peut modifier ce réglage.</p> : null}
      <div aria-live="polite">{message ? <Notice tone={message.tone}>{message.text}</Notice> : null}</div>
      <div className="p-form__actions">
        {locked ? null : (
          <Button busy={busy} onClick={save}>
            Enregistrer
          </Button>
        )}
      </div>
    </section>
  );
}
