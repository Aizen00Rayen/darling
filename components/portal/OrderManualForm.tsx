'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Notice } from '@/ui';
import { MANUAL_ORDER_SOURCES, type OrderDetail, type OrderSource } from '@/shared';
import { wilayas, type DeliveryMode } from '@/data/delivery';
import { defaultProduct } from '@/data/products';
import { useHydrated } from '@/lib/auth/use-hydrated';
import { api } from '@/lib/api/client';
import { clampQuantity, deskAvailable, resolveMode, summary } from '@/lib/order-form-state';
import { apiMessage, fieldErrorsOf } from '@/lib/portal/messages';
import { orderSourceLabel, shadeLabel } from '@/lib/portal/orders';

const KNOWN_FIELDS = ['affiliateCode', 'source', 'fullName', 'phone', 'wilayaCode', 'commune', 'mode', 'address', 'shadeCode', 'quantity'];

/** Staff entry of an order that came in outside the website (Instagram, WhatsApp...). Prices come from the server. */
export function OrderManualForm() {
  const router = useRouter();
  const hydrated = useHydrated();
  const product = defaultProduct;

  const [source, setSource] = useState<OrderSource | ''>('');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [wilayaCode, setWilayaCode] = useState<number | null>(null);
  const [commune, setCommune] = useState('');
  const [chosenMode, setChosenMode] = useState<DeliveryMode>('desk');
  const [address, setAddress] = useState('');
  const [shadeCode, setShadeCode] = useState(product.shades[0]?.code ?? '');
  const [quantity, setQuantity] = useState(1);
  const [affiliateCode, setAffiliateCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const mode = resolveMode(wilayaCode, chosenMode);
  const home = mode === 'home';
  const { delivery, total } = summary({ price: product.price, quantity, wilayaCode, mode });

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    const local: Record<string, string> = {};
    if (source === '') local.source = 'Choisissez la provenance de la commande.';
    if (fullName.trim().length < 2) local.fullName = 'Le nom est requis.';
    if (phone.trim() === '') local.phone = 'Le téléphone est requis.';
    if (wilayaCode === null) local.wilayaCode = 'Choisissez la wilaya.';
    if (commune.trim().length < 2) local.commune = 'La commune est requise.';
    if (home && address.trim().length < 5) local.address = 'Indiquez l’adresse de livraison.';
    setFieldErrors(local);
    if (Object.keys(local).length > 0) return;

    setBusy(true);
    const result = await api<OrderDetail>('/api/orders/manual', {
      method: 'POST',
      body: {
        source,
        productSlug: product.slug,
        shadeCode,
        quantity,
        fullName: fullName.trim(),
        phone: phone.trim(),
        wilayaCode,
        commune: commune.trim(),
        mode,
        ...(home ? { address: address.trim() } : {}),
        ...(affiliateCode.trim() !== '' ? { affiliateCode: affiliateCode.trim().toUpperCase() } : {}),
      },
    });
    setBusy(false);
    if (!result.ok) {
      const errors = fieldErrorsOf(result);
      setFieldErrors(errors);
      const unmapped = Object.entries(errors).filter(([key]) => !KNOWN_FIELDS.includes(key));
      if (result.code === 'validation' && unmapped.length === 0 && Object.keys(errors).length > 0) return;
      setError(result.code === 'validation' && unmapped.length > 0 ? unmapped.map(([, m]) => m).join(' ') : apiMessage(result.code));
      return;
    }
    router.push(`/admin/commandes/${result.data.id}?created=1`);
    router.refresh();
  }

  return (
    <form className="p-form" method="post" onSubmit={onSubmit} noValidate>
      {error ? <Notice tone="error">{error}</Notice> : null}

      <div className="p-grid p-grid--2">
        <Field label="Provenance" error={fieldErrors.source}>
          <select name="source" value={source} onChange={(e) => setSource(e.target.value as OrderSource | '')}>
            <option value="">Choisissez…</option>
            {MANUAL_ORDER_SOURCES.map((s) => (
              <option key={s} value={s}>
                {orderSourceLabel(s)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Produit">
          <input type="text" value={product.name} readOnly />
        </Field>
        <Field label="Teinte" error={fieldErrors.shadeCode}>
          <select name="shadeCode" value={shadeCode} onChange={(e) => setShadeCode(e.target.value)}>
            {product.shades.map((s) => (
              <option key={s.code} value={s.code}>
                {shadeLabel(s.code)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Quantité" error={fieldErrors.quantity}>
          <input
            type="number"
            name="quantity"
            min={1}
            max={product.maxQuantity}
            inputMode="numeric"
            value={quantity}
            onChange={(e) => setQuantity(clampQuantity(Number.parseInt(e.target.value, 10) || 1, product.maxQuantity))}
          />
        </Field>
        <Field label="Nom et prénom" error={fieldErrors.fullName}>
          <input type="text" name="fullName" autoComplete="off" maxLength={120} value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </Field>
        <Field label="Téléphone" hint="Numéro mobile algérien, par exemple 0550 12 34 56." error={fieldErrors.phone}>
          <input type="tel" name="phone" autoComplete="off" inputMode="tel" maxLength={18} value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field label="Wilaya" error={fieldErrors.wilayaCode}>
          <select
            name="wilayaCode"
            value={wilayaCode ?? ''}
            onChange={(e) => {
              const code = e.target.value ? Number(e.target.value) : null;
              setWilayaCode(code);
              setChosenMode((current) => resolveMode(code, current));
            }}
          >
            <option value="">Choisissez…</option>
            {wilayas.map((w) => (
              <option key={w.code} value={w.code}>
                {String(w.code).padStart(2, '0')} — {w.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Commune" error={fieldErrors.commune}>
          <input type="text" name="commune" autoComplete="off" maxLength={120} value={commune} onChange={(e) => setCommune(e.target.value)} />
        </Field>
      </div>

      <fieldset className="p-fieldset">
        <legend>Mode de livraison</legend>
        <label className="p-check">
          <input type="radio" name="mode" value="desk" checked={!home} disabled={!deskAvailable(wilayaCode)} onChange={() => setChosenMode('desk')} />
          <span>Stop Desk (retrait au bureau){!deskAvailable(wilayaCode) ? ' — indisponible dans cette wilaya' : ''}</span>
        </label>
        <label className="p-check">
          <input type="radio" name="mode" value="home" checked={home} onChange={() => setChosenMode('home')} />
          <span>À domicile</span>
        </label>
        {fieldErrors.mode ? <p className="dl-field__error">{fieldErrors.mode}</p> : null}
      </fieldset>

      {home ? (
        <Field label="Adresse de livraison" error={fieldErrors.address}>
          <input type="text" name="address" autoComplete="off" maxLength={200} value={address} onChange={(e) => setAddress(e.target.value)} />
        </Field>
      ) : null}

      <Field label="Code influenceuse (facultatif)" hint="Attribue la commande à une influenceuse (par exemple AYA001) : ses commissions seront créées." error={fieldErrors.affiliateCode}>
        <input type="text" name="affiliateCode" autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={12} value={affiliateCode} onChange={(e) => setAffiliateCode(e.target.value)} />
      </Field>

      <dl className="p-dl p-totals" aria-live="polite">
        <div>
          <dt>Livraison</dt>
          <dd>{delivery}</dd>
        </div>
        <div>
          <dt>Total</dt>
          <dd>
            <strong>{total}</strong>
          </dd>
        </div>
      </dl>

      <div className="p-form__actions">
        <Button type="submit" busy={busy} disabled={!hydrated}>
          Enregistrer la commande
        </Button>
      </div>
    </form>
  );
}
