'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Notice } from '@/ui';
import { api } from '@/lib/api/client';
import { apiMessage, fieldErrorsOf } from '@/lib/portal/messages';
import { ConfirmDialog } from './ConfirmDialog';

export type EditableOrder = {
  id: string;
  number: string;
  customerName: string;
  phone: string;
  wilayaCode: number;
  commune: string;
  deliveryMode: 'desk' | 'home';
  address: string | null;
  shadeCode: string;
  quantity: number;
  unitPrice: number;
  deliveryFee: number;
};

/** Full edit and delete of an order for staff with orders.write. Stock is adjusted by the server in the same step. */
export function OrderEditPanel({ order, shades, wilayas }: { order: EditableOrder; shades: string[]; wilayas: { code: number; name: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [f, setF] = useState({
    customerName: order.customerName,
    phone: order.phone,
    wilayaCode: String(order.wilayaCode),
    commune: order.commune,
    mode: order.deliveryMode,
    address: order.address ?? '',
    shadeCode: order.shadeCode,
    quantity: String(order.quantity),
    unitPrice: String(order.unitPrice),
    deliveryFee: String(order.deliveryFee),
  });
  const set = (k: keyof typeof f, v: string) => {
    setF((p) => ({ ...p, [k]: v }));
    setSaved(false);
  };

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setErrors({});
    setBusy(true);
    const result = await api(`/api/orders/${order.id}/edit`, {
      method: 'PATCH',
      body: {
        customerName: f.customerName,
        phone: f.phone,
        wilayaCode: Number(f.wilayaCode),
        commune: f.commune,
        mode: f.mode,
        ...(f.mode === 'home' ? { address: f.address } : {}),
        shadeCode: f.shadeCode,
        quantity: Number(f.quantity),
        unitPrice: Number(f.unitPrice),
        deliveryFee: Number(f.deliveryFee),
      },
    });
    setBusy(false);
    if (!result.ok) {
      setErrors(fieldErrorsOf(result));
      setError(apiMessage(result.code));
      return;
    }
    setSaved(true);
    router.refresh();
  }

  async function remove() {
    setBusy(true);
    const result = await api(`/api/orders/${order.id}`, { method: 'DELETE' });
    setBusy(false);
    if (!result.ok) {
      setConfirmDelete(false);
      setError(apiMessage(result.code));
      return;
    }
    router.push('/admin/commandes');
    router.refresh();
  }

  return (
    <section className="p-card glass" aria-labelledby="o-edit">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <h2 className="p-card__title" id="o-edit">
          Gérer la commande
        </h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="ghost" onClick={() => setOpen((v) => !v)}>
            {open ? 'Fermer' : 'Modifier'}
          </Button>
          <Button variant="danger" onClick={() => setConfirmDelete(true)}>
            Supprimer
          </Button>
        </div>
      </div>
      {error && !open ? <Notice tone="error">{error}</Notice> : null}
      {open ? (
        <form className="p-form" method="post" onSubmit={save} noValidate>
          {error ? <Notice tone="error">{error}</Notice> : null}
          {saved ? <Notice tone="success">Commande mise à jour. Le stock a été ajusté si nécessaire.</Notice> : null}
          <div className="p-grid p-grid--2">
            <Field label="Nom et prénom" {...(errors.customerName ? { error: errors.customerName } : {})}>
              <input value={f.customerName} onChange={(e) => set('customerName', e.target.value)} />
            </Field>
            <Field label="Téléphone" {...(errors.phone ? { error: errors.phone } : {})}>
              <input inputMode="tel" value={f.phone} onChange={(e) => set('phone', e.target.value)} />
            </Field>
            <Field label="Wilaya" {...(errors.wilayaCode ? { error: errors.wilayaCode } : {})}>
              <select value={f.wilayaCode} onChange={(e) => set('wilayaCode', e.target.value)}>
                {wilayas.map((w) => (
                  <option key={w.code} value={w.code}>
                    {String(w.code).padStart(2, '0')} — {w.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Commune" {...(errors.commune ? { error: errors.commune } : {})}>
              <input value={f.commune} onChange={(e) => set('commune', e.target.value)} />
            </Field>
            <Field label="Mode de livraison" {...(errors.mode ? { error: errors.mode } : {})}>
              <select value={f.mode} onChange={(e) => set('mode', e.target.value)}>
                <option value="desk">Stop Desk</option>
                <option value="home">À domicile</option>
              </select>
            </Field>
            {f.mode === 'home' ? (
              <Field label="Adresse" {...(errors.address ? { error: errors.address } : {})}>
                <input value={f.address} onChange={(e) => set('address', e.target.value)} />
              </Field>
            ) : null}
            <Field label="Teinte" {...(errors.shadeCode ? { error: errors.shadeCode } : {})}>
              <select value={f.shadeCode} onChange={(e) => set('shadeCode', e.target.value)}>
                {shades.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Quantité" {...(errors.quantity ? { error: errors.quantity } : {})}>
              <input type="number" min={1} value={f.quantity} onChange={(e) => set('quantity', e.target.value)} />
            </Field>
            <Field label="Prix unitaire (DA)" hint="Prix de vente appliqué à cette commande" {...(errors.unitPrice ? { error: errors.unitPrice } : {})}>
              <input type="number" min={0} value={f.unitPrice} onChange={(e) => set('unitPrice', e.target.value)} />
            </Field>
            <Field label="Frais de livraison (DA)" {...(errors.deliveryFee ? { error: errors.deliveryFee } : {})}>
              <input type="number" min={0} value={f.deliveryFee} onChange={(e) => set('deliveryFee', e.target.value)} />
            </Field>
          </div>
          <Button type="submit" busy={busy}>
            Enregistrer les modifications
          </Button>
        </form>
      ) : null}
      <ConfirmDialog open={confirmDelete} title={`Supprimer ${order.number} ?`} confirmLabel="Supprimer définitivement" tone="danger" busy={busy} onConfirm={remove} onCancel={() => setConfirmDelete(false)}>
        <p>La commande disparaît des listes et des totaux, son stock est remis en rayon et ses commissions sont annulées. L’opération est tracée dans le journal.</p>
      </ConfirmDialog>
    </section>
  );
}
