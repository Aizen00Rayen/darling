'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Notice } from '@/ui';
import { api } from '@/lib/api/client';
import { apiMessage } from '@/lib/portal/messages';
import type { StockProduct } from '@/shared/stock';

/** Edit the exact stock of a product: quantity per shade, alert level and (with catalog.write) the selling price. */
export function StockLevelsForm({ products, canPrice }: { products: StockProduct[]; canPrice: boolean }) {
  const router = useRouter();
  const [productId, setProductId] = useState(products[0]?.id ?? '');
  const product = products.find((p) => p.id === productId);
  const initial = (p?: StockProduct) => Object.fromEntries((p?.shades ?? []).map((s) => [s.shadeCode, String(s.quantity)]));
  const [levels, setLevels] = useState<Record<string, string>>(initial(product));
  const [threshold, setThreshold] = useState(String(product?.lowStockThreshold ?? 10));
  const [price, setPrice] = useState(String(product?.price ?? 0));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  function pick(id: string) {
    const p = products.find((x) => x.id === id);
    setProductId(id);
    setLevels(initial(p));
    setThreshold(String(p?.lowStockThreshold ?? 10));
    setPrice(String(p?.price ?? 0));
    setDone(null);
    setError(null);
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || !product) return;
    setError(null);
    setDone(null);
    const numbers: Record<string, number> = {};
    for (const [k, v] of Object.entries(levels)) {
      const n = Number(v);
      if (v.trim() === '' || !Number.isInteger(n) || n < 0) {
        setError('Chaque quantité doit être un entier positif ou nul.');
        return;
      }
      numbers[k] = n;
    }
    const th = Number(threshold);
    if (!Number.isInteger(th) || th < 0) {
      setError('Seuil d’alerte invalide.');
      return;
    }
    setBusy(true);
    const result = await api<StockProduct>('/api/stock/levels', {
      method: 'POST',
      body: { productId, levels: numbers, lowStockThreshold: th, ...(note.trim() ? { note: note.trim() } : {}) },
    });
    if (result.ok && canPrice && Number(price) !== product.price) {
      const p = Number(price);
      if (!Number.isInteger(p) || p < 0) {
        setBusy(false);
        setError('Prix de vente invalide.');
        return;
      }
      const priced = await api(`/api/products/${productId}`, { method: 'PATCH', body: { price: p } });
      if (!priced.ok) {
        setBusy(false);
        setError(apiMessage(priced.code));
        return;
      }
    }
    setBusy(false);
    if (!result.ok) {
      setError(apiMessage(result.code));
      return;
    }
    setDone(`Stock de ${result.data.name} mis à jour : ${result.data.total} unités.`);
    setNote('');
    router.refresh();
  }

  return (
    <form className="p-form" method="post" onSubmit={submit} noValidate>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {done ? <Notice tone="success">{done}</Notice> : null}
      <Field label="Produit">
        <select value={productId} onChange={(e) => pick(e.target.value)}>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="p-grid p-grid--2">
        {product?.shades.map((s) => (
          <Field key={s.shadeCode || 'pool'} label={s.shadeCode === '' ? 'Non réparti' : `Teinte ${s.shadeCode}`} hint={`Actuellement : ${s.quantity}`}>
            <input type="number" min={0} step={1} inputMode="numeric" value={levels[s.shadeCode] ?? ''} onChange={(e) => setLevels((l) => ({ ...l, [s.shadeCode]: e.target.value }))} />
          </Field>
        ))}
        <Field label="Seuil d’alerte stock bas" hint="Une alerte s’affiche à ce niveau ou en dessous">
          <input type="number" min={0} step={1} inputMode="numeric" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
        </Field>
        {canPrice ? (
          <Field label="Prix de vente (DA)" hint="Prix public du produit">
            <input type="number" min={0} step={1} inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value)} />
          </Field>
        ) : null}
      </div>
      <Field label="Raison (optionnel)">
        <input type="text" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex : inventaire du 16/11" />
      </Field>
      <Button type="submit" busy={busy}>
        Enregistrer le stock
      </Button>
    </form>
  );
}
