'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Notice } from '@/ui';
import { api } from '@/lib/api/client';
import { apiMessage } from '@/lib/portal/messages';
import { OFFSITE_CHANNELS, OFFSITE_CHANNEL_LABELS, type OffsiteChannel, type StockProduct } from '@/shared/stock';

type Action = 'purchase' | 'sale_offsite' | 'return' | 'damage' | 'adjustment';
const ACTIONS: { value: Action; label: string }[] = [
  { value: 'sale_offsite', label: 'Vente hors site (Instagram, WhatsApp, boutique…)' },
  { value: 'purchase', label: 'Réception de marchandise' },
  { value: 'return', label: 'Retour client hors commande' },
  { value: 'damage', label: 'Casse / perte' },
  { value: 'adjustment', label: 'Correction d’inventaire' },
];

export function StockMovementForm({ products }: { products: StockProduct[] }) {
  const router = useRouter();
  const [productId, setProductId] = useState(products[0]?.id ?? '');
  const [shadeCode, setShadeCode] = useState('');
  const [action, setAction] = useState<Action>('sale_offsite');
  const [quantity, setQuantity] = useState('1');
  const [direction, setDirection] = useState<'in' | 'out'>('in');
  const [channel, setChannel] = useState<OffsiteChannel>('instagram');
  const [unitPrice, setUnitPrice] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<string | null>(null);

  const product = products.find((p) => p.id === productId);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !product) return;
    setError(null);
    setFieldErrors({});
    setDone(null);
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty < 1) {
      setFieldErrors({ quantity: 'Indiquez une quantité entière (1 minimum).' });
      return;
    }
    const price = unitPrice.trim() === '' ? undefined : Number(unitPrice);
    if (price !== undefined && (!Number.isInteger(price) || price < 0)) {
      setFieldErrors({ unitPrice: 'Prix invalide (dinars, entier).' });
      return;
    }
    setBusy(true);
    const result = await api<StockProduct>('/api/stock/movements', {
      method: 'POST',
      body: {
        productId,
        shadeCode,
        reason: action,
        quantity: qty,
        ...(action === 'adjustment' ? { direction } : {}),
        ...(action === 'sale_offsite' ? { channel } : {}),
        ...(price !== undefined ? { unitPrice: price } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      },
    });
    setBusy(false);
    if (!result.ok) {
      if (result.errors) setFieldErrors(result.errors);
      setError(apiMessage(result.code));
      return;
    }
    setDone(`Enregistré. Stock de ${result.data.name} : ${result.data.total} unités.`);
    setQuantity('1');
    setNote('');
    router.refresh();
  }

  return (
    <form className="p-form" method="post" onSubmit={onSubmit} noValidate>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {done ? <Notice tone="success">{done}</Notice> : null}
      <div className="p-grid p-grid--2">
        <Field label="Produit">
          <select
            value={productId}
            onChange={(e) => {
              setProductId(e.target.value);
              setShadeCode('');
            }}
          >
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Teinte" hint="« Non réparti » = stock dont la teinte n’est pas précisée." {...(fieldErrors.shadeCode ? { error: fieldErrors.shadeCode } : {})}>
          <select value={shadeCode} onChange={(e) => setShadeCode(e.target.value)}>
            <option value="">Non réparti</option>
            {product?.shades
              .filter((s) => s.shadeCode !== '')
              .map((s) => (
                <option key={s.shadeCode} value={s.shadeCode}>
                  {s.shadeCode} (en stock : {s.quantity})
                </option>
              ))}
          </select>
        </Field>
        <Field label="Opération">
          <select value={action} onChange={(e) => setAction(e.target.value as Action)}>
            {ACTIONS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Quantité" {...(fieldErrors.quantity ? { error: fieldErrors.quantity } : {})}>
          <input type="number" min={1} step={1} inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </Field>
        {action === 'adjustment' ? (
          <Field label="Sens de la correction">
            <select value={direction} onChange={(e) => setDirection(e.target.value as 'in' | 'out')}>
              <option value="in">Ajouter au stock</option>
              <option value="out">Retirer du stock</option>
            </select>
          </Field>
        ) : null}
        {action === 'sale_offsite' ? (
          <Field label="Canal de vente">
            <select value={channel} onChange={(e) => setChannel(e.target.value as OffsiteChannel)}>
              {OFFSITE_CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {OFFSITE_CHANNEL_LABELS[c]}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        {action === 'sale_offsite' || action === 'purchase' ? (
          <Field
            label={action === 'purchase' ? 'Coût unitaire (DA, optionnel)' : 'Prix de vente unitaire (DA, optionnel)'}
            {...(fieldErrors.unitPrice ? { error: fieldErrors.unitPrice } : {})}
          >
            <input type="number" min={0} step={1} inputMode="numeric" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} />
          </Field>
        ) : null}
      </div>
      <Field
        label={action === 'adjustment' || action === 'damage' ? 'Raison (obligatoire)' : 'Note (optionnel)'}
        {...(fieldErrors.note ? { error: fieldErrors.note } : {})}
      >
        <input type="text" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex : vendu à une cliente via Instagram" />
      </Field>
      <Button type="submit" busy={busy}>
        Enregistrer le mouvement
      </Button>
    </form>
  );
}
