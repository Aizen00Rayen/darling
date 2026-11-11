'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Notice } from '@/ui';
import { api } from '@/lib/api/client';
import { apiMessage, fieldErrorsOf } from '@/lib/portal/messages';
import { ConfirmDialog } from './ConfirmDialog';

type Props = {
  id: string;
  status: string;
  onHold: boolean;
};

const REASON_MAX = 500;

/**
 * Row actions of one commission: "Libérer" for a held pending commission, "Annuler" (with a required reason) while it is
 * pending or validated. A paid or cancelled commission has none. Every click goes through the API, which judges again.
 */
export function CommissionActions({ id, status, onHold }: Props) {
  const router = useRouter();
  const [dialog, setDialog] = useState<'release' | 'cancel' | null>(null);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canRelease = status === 'pending' && onHold;
  const canCancel = status === 'pending' || status === 'validated';
  if (!canRelease && !canCancel) return <span className="p-subtle">—</span>;

  function open(which: 'release' | 'cancel') {
    setError(null);
    setReasonError(null);
    setReason('');
    setDialog(which);
  }

  async function run() {
    if (!dialog || busy) return;
    const trimmed = reason.trim();
    if (dialog === 'cancel') {
      if (trimmed === '') return setReasonError('Indiquez le motif de l’annulation.');
      if (trimmed.length > REASON_MAX) return setReasonError(`Le motif est trop long (${REASON_MAX} caractères maximum).`);
    }
    setBusy(true);
    const result = await api(`/api/commissions/${id}/${dialog === 'release' ? 'release-hold' : 'cancel'}`, {
      method: 'POST',
      ...(dialog === 'cancel' ? { body: { reason: trimmed } } : {}),
    });
    setBusy(false);
    if (!result.ok) {
      const fieldMessage = fieldErrorsOf(result).reason;
      if (fieldMessage) return setReasonError(fieldMessage);
      setDialog(null);
      setError(apiMessage(result.code));
      router.refresh(); // someone else may have changed it: show what it is now
      return;
    }
    setDialog(null);
    router.refresh();
  }

  return (
    <div className="p-actions">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {canRelease ? (
        <Button variant="ghost" onClick={() => open('release')}>
          Libérer
        </Button>
      ) : null}
      {canCancel ? (
        <Button variant="danger" onClick={() => open('cancel')}>
          Annuler
        </Button>
      ) : null}
      <ConfirmDialog
        open={dialog !== null}
        title={dialog === 'release' ? 'Libérer cette commission ?' : 'Annuler cette commission ?'}
        confirmLabel={dialog === 'release' ? 'Libérer' : 'Annuler la commission'}
        tone={dialog === 'release' ? 'primary' : 'danger'}
        busy={busy}
        onConfirm={run}
        onCancel={() => setDialog(null)}
      >
        {dialog === 'release' ? (
          <p className="p-lead">La commission était retenue (auto-référence). Une fois libérée, elle sera validée dès que la commande est livrée.</p>
        ) : (
          <>
            <p className="p-lead">Une commission annulée ne sera jamais payée. Cette action est définitive.</p>
            <Field label="Motif (obligatoire)" {...(reasonError ? { error: reasonError } : {})}>
              <textarea name="reason" rows={3} maxLength={REASON_MAX + 50} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
          </>
        )}
      </ConfirmDialog>
    </div>
  );
}
