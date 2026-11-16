'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Notice } from '@/ui';
import { api } from '@/lib/api/client';
import { apiMessage } from '@/lib/portal/messages';
import { ConfirmDialog } from './ConfirmDialog';

/** Deletes (hides) a product from the shop and the lists; its stock history and past orders stay. */
export function DeleteProductButton({ id, name, disabled }: { id: string; name: string; disabled?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    const result = await api(`/api/products/${id}`, { method: 'DELETE' });
    setBusy(false);
    setOpen(false);
    if (!result.ok) {
      setError(result.errors?.product ?? apiMessage(result.code));
      return;
    }
    router.refresh();
  }

  return (
    <>
      <Button variant="danger" disabled={disabled} onClick={() => setOpen(true)} style={{ padding: '0.25rem 0.6rem', fontSize: '0.85rem' }}>
        Supprimer
      </Button>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <ConfirmDialog open={open} title={`Supprimer ${name} ?`} confirmLabel="Supprimer" tone="danger" busy={busy} onConfirm={run} onCancel={() => setOpen(false)}>
        <p>Le produit disparaît de la boutique et des listes. L’historique de stock et les commandes passées sont conservés. Le produit par défaut ne peut pas être supprimé.</p>
      </ConfirmDialog>
    </>
  );
}
