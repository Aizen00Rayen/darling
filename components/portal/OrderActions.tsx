'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Notice } from '@/ui';
import { STATUS_NOTE_MAX, nextStatuses, type OrderStatus } from '@/shared';
import { api } from '@/lib/api/client';
import { apiMessage, fieldErrorsOf } from '@/lib/portal/messages';
import { orderActionFor, orderStatusLabel } from '@/lib/portal/orders';
import { ConfirmDialog } from './ConfirmDialog';

type Props = { orderId: string; status: OrderStatus };

/** Buttons for ONLY the statuses the machine allows from the current one; each asks for confirmation first. */
export function OrderActions({ orderId, status }: Props) {
  const router = useRouter();
  const [pending, setPending] = useState<OrderStatus | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const options = nextStatuses(status);

  function open(to: OrderStatus) {
    setError(null);
    setNoteError(null);
    setDone(null);
    setNote('');
    setPending(to);
  }

  async function run() {
    if (!pending || busy) return;
    const to = pending;
    const trimmed = note.trim();
    setBusy(true);
    const result = await api(`/api/orders/${orderId}/status`, { method: 'POST', body: { to, ...(orderActionFor(to).askNote && trimmed !== '' ? { note: trimmed } : {}) } });
    setBusy(false);
    if (!result.ok) {
      const fieldMessage = fieldErrorsOf(result).note;
      if (fieldMessage) {
        setNoteError(fieldMessage);
        return;
      }
      setPending(null);
      setError(apiMessage(result.code));
      // The order moved under us (another person acted): show what it is now.
      if (result.code === 'invalid_transition') router.refresh();
      return;
    }
    setPending(null);
    setDone(`Commande ${orderStatusLabel(to).toLowerCase()}.`);
    router.refresh();
  }

  const action = pending ? orderActionFor(pending) : null;

  return (
    <div className="p-stack">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {done ? <Notice tone="success">{done}</Notice> : null}
      {options.length === 0 ? (
        <p className="p-lead">Cette commande est terminée : aucun changement de statut n’est possible.</p>
      ) : (
        <div className="p-actions">
          {options.map((to) => (
            <Button key={to} variant={orderActionFor(to).tone === 'danger' ? 'danger' : 'primary'} onClick={() => open(to)}>
              {orderActionFor(to).label}
            </Button>
          ))}
        </div>
      )}
      <ConfirmDialog
        open={pending !== null}
        title={action?.title ?? ''}
        confirmLabel={action?.confirm ?? ''}
        tone={action?.tone ?? 'primary'}
        busy={busy}
        onConfirm={run}
        onCancel={() => setPending(null)}
      >
        {action?.description ? <p className="p-lead">{action.description}</p> : null}
        {action?.askNote ? (
          <Field label="Note (facultatif)" {...(noteError ? { error: noteError } : {})}>
            <textarea name="note" maxLength={STATUS_NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
