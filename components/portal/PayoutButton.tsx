'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Notice } from '@/ui';
import { PAYOUT_METHODS } from '@/shared';
import { api } from '@/lib/api/client';
import { algiersToday, formatSignedMoney, payoutFormErrors, payoutMethodLabel } from '@/lib/portal/commissions';
import { apiMessage, fieldErrorsOf } from '@/lib/portal/messages';
import { formatMoney } from '@/lib/pricing';
import { ConfirmDialog } from './ConfirmDialog';

type Props = {
  beneficiaryUserId: string;
  name: string;
  /** What the server computed when the page was rendered: commissions + unsettled adjustments. */
  amount: number;
  commissions: number;
  adjustments: number;
  commissionCount: number;
};

/** "Payer": a dialog that shows the amount, asks for method, reference and date, and records the payout in one request. */
export function PayoutButton({ beneficiaryUserId, name, amount, commissions, adjustments, commissionCount }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<string>('cash');
  const [reference, setReference] = useState('');
  const [paidAt, setPaidAt] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  function show() {
    setError(null);
    setDone(null);
    setFieldErrors({});
    setMethod('cash');
    setReference('');
    setNote('');
    setPaidAt(algiersToday());
    setOpen(true);
  }

  async function submit() {
    if (busy) return;
    const local = payoutFormErrors({ method, reference, paidAt, note }, algiersToday());
    setFieldErrors(local);
    if (Object.keys(local).length > 0) return;
    setBusy(true);
    const result = await api<{ amount: number }>('/api/payouts', {
      method: 'POST',
      body: { beneficiaryUserId, method, paidAt, ...(reference.trim() !== '' ? { reference: reference.trim() } : {}), ...(note.trim() !== '' ? { note: note.trim() } : {}) },
    });
    setBusy(false);
    if (!result.ok) {
      const errors = fieldErrorsOf(result);
      if (Object.keys(errors).length > 0) return setFieldErrors(errors);
      setOpen(false);
      setError(apiMessage(result.code));
      router.refresh(); // a double click or another admin got there first: show what is left
      return;
    }
    setOpen(false);
    setDone(`Paiement de ${formatMoney(result.data.amount)} enregistré.`);
    router.refresh();
  }

  return (
    <div className="p-actions">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {done ? <Notice tone="success">{done}</Notice> : null}
      <Button onClick={show} disabled={amount <= 0} aria-label={`Payer ${name}`}>
        Payer
      </Button>
      <ConfirmDialog open={open} title={`Payer ${name}`} confirmLabel={`Payer ${formatMoney(amount)}`} busy={busy} onConfirm={submit} onCancel={() => setOpen(false)}>
        <dl className="p-dl">
          <div>
            <dt>Montant à payer</dt>
            <dd>
              <strong>{formatMoney(amount)}</strong>
            </dd>
          </div>
          <div>
            <dt>Détail</dt>
            <dd>
              {commissionCount} commission{commissionCount > 1 ? 's' : ''} validée{commissionCount > 1 ? 's' : ''} ({formatMoney(commissions)})
              {adjustments !== 0 ? `, déductions : ${formatSignedMoney(adjustments)}` : ''}
            </dd>
          </div>
        </dl>
        <Field label="Mode de paiement" error={fieldErrors.method}>
          <select name="method" value={method} onChange={(e) => setMethod(e.target.value)}>
            {PAYOUT_METHODS.map((m) => (
              <option key={m} value={m}>
                {payoutMethodLabel(m)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Référence (facultatif)" hint="Numéro de virement, de reçu…" error={fieldErrors.reference}>
          <input type="text" name="reference" autoComplete="off" maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
        <Field label="Date du paiement" error={fieldErrors.paidAt}>
          <input type="date" name="paidAt" value={paidAt} max={algiersToday()} onChange={(e) => setPaidAt(e.target.value)} />
        </Field>
        <Field label="Note (facultatif)" error={fieldErrors.note}>
          <textarea name="note" rows={2} maxLength={550} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </ConfirmDialog>
    </div>
  );
}
