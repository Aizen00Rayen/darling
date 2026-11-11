'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Notice } from '@/ui';
import { INTERNAL_NOTES_MAX } from '@/shared';
import { api } from '@/lib/api/client';
import { apiMessage, fieldErrorsOf } from '@/lib/portal/messages';

type Props = { orderId: string; notes: string | null };

export function OrderNotesForm({ orderId, notes }: Props) {
  const router = useRouter();
  const [value, setValue] = useState(notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setFieldError(undefined);
    setSaved(false);
    if (value.trim().length > INTERNAL_NOTES_MAX) {
      setFieldError(`Les notes sont trop longues (${INTERNAL_NOTES_MAX} caractères maximum).`);
      return;
    }
    setBusy(true);
    const result = await api(`/api/orders/${orderId}`, { method: 'PATCH', body: { internalNotes: value.trim() === '' ? null : value } });
    setBusy(false);
    if (!result.ok) {
      const errors = fieldErrorsOf(result);
      if (errors.internalNotes) setFieldError(errors.internalNotes);
      else setError(apiMessage(result.code));
      return;
    }
    setSaved(true);
    router.refresh();
  }

  return (
    <form className="p-form" method="post" onSubmit={onSubmit} noValidate>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {saved ? <Notice tone="success">Notes enregistrées.</Notice> : null}
      <Field label="Notes internes" hint="Visibles uniquement par l’équipe." {...(fieldError ? { error: fieldError } : {})}>
        <textarea
          name="internalNotes"
          rows={5}
          maxLength={INTERNAL_NOTES_MAX + 200}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setSaved(false);
          }}
        />
      </Field>
      <p className="p-lead" aria-live="polite">
        {value.length} / {INTERNAL_NOTES_MAX} caractères
      </p>
      <div className="p-form__actions">
        <Button type="submit" busy={busy}>
          Enregistrer les notes
        </Button>
      </div>
    </form>
  );
}
