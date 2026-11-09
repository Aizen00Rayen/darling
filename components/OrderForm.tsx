'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { wilayas, type DeliveryMode } from '@/data/delivery';
import type { Product } from '@/data/products';
import { clampQuantity, deskAvailable, resolveMode, summary } from '@/lib/order-form-state';
import { parseOrder, type FieldErrors } from '@/lib/order-schema';
import { ArrowIcon, AsteriskIcon } from './icons';

const TIMEOUT_MS = 25_000;
const TIMEOUT_MESSAGE =
  'La confirmation prend trop de temps. Vérifiez votre connexion avant de réessayer ; votre demande a peut-être été reçue.';
const FAILURE_MESSAGE =
  'La commande n’a pas pu être confirmée. Vos informations sont conservées dans le formulaire ; veuillez réessayer.';

export const ORDER_FORM_ID = 'commande';

type Props = { product: Product; shadeCode: string };

export function OrderForm({ product, shadeCode }: Props) {
  const router = useRouter();
  const phoneRef = useRef<HTMLInputElement>(null);

  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [wilayaCode, setWilayaCode] = useState<number | null>(null);
  const [commune, setCommune] = useState('');
  const [chosenMode, setChosenMode] = useState<DeliveryMode>('desk');
  const [address, setAddress] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const mode = resolveMode(wilayaCode, chosenMode);
  const home = mode === 'home';
  const { delivery, total } = summary({ price: product.price, quantity, wilayaCode, mode });

  const fieldError = (field: keyof FieldErrors) =>
    errors[field] ? <small className="field-error">{errors[field]}</small> : null;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const parsed = parseOrder({
      productSlug: product.slug,
      shadeCode,
      quantity,
      fullName,
      phone,
      wilayaCode,
      commune,
      mode,
      address: home ? address : undefined,
    });
    if (!parsed.ok) {
      setErrors(parsed.errors);
      if (parsed.errors.phone && phoneRef.current) {
        phoneRef.current.setCustomValidity(parsed.errors.phone);
        phoneRef.current.reportValidity();
      }
      return;
    }

    setErrors({});
    setStatus('Envoi de votre commande…');
    setPending(true);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(parsed.order),
        signal: controller.signal,
      });
      const data = await response.json();
      if (response.status === 400 && data?.errors && Object.keys(data.errors).length > 0) {
        setErrors(data.errors);
        setStatus(null);
        setPending(false);
        return;
      }
      if (!response.ok || !data?.ok) throw new Error('Submission failed');
      router.push('/merci');
    } catch (error) {
      setStatus(error instanceof Error && error.name === 'AbortError' ? TIMEOUT_MESSAGE : FAILURE_MESSAGE);
      setPending(false);
    } finally {
      clearTimeout(timeout);
    }
  }

  return (
    <form id={ORDER_FORM_ID} className="order glass" onSubmit={onSubmit} aria-busy={pending || undefined}>
      <div className="order-heading">
        <div>
          <p className="eyebrow">VOTRE PROCHAIN COUP DE CŒUR</p>
          <h2>Il est à vous.</h2>
        </div>
        <span className="order-star">
          <AsteriskIcon />
        </span>
      </div>

      <div className="form-grid">
        <label>
          Nom et prénom
          <input
            required
            name="fullName"
            autoComplete="name"
            placeholder="Votre nom complet"
            maxLength={100}
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
          />
          {fieldError('fullName')}
        </label>
        <label>
          Téléphone
          <input
            ref={phoneRef}
            required
            name="phone"
            autoComplete="tel"
            inputMode="tel"
            type="tel"
            pattern="(?:0[567][0-9 ]{8,12}|\+213[567][0-9 ]{8,12})"
            placeholder="05 / 06 / 07…"
            title="Numéro algérien : 05, 06 ou 07 suivi de 8 chiffres, ou +213"
            maxLength={18}
            value={phone}
            onChange={(e) => {
              e.target.setCustomValidity('');
              setPhone(e.target.value);
            }}
          />
        </label>
        <label>
          Wilaya
          <select
            name="wilayaCode"
            required
            value={wilayaCode ?? ''}
            onChange={(e) => setWilayaCode(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">Choisissez votre wilaya</option>
            {wilayas.map((wilaya) => (
              <option key={wilaya.code} value={wilaya.code}>
                {String(wilaya.code).padStart(2, '0')} — {wilaya.name}
              </option>
            ))}
          </select>
          {fieldError('wilayaCode')}
        </label>
        <label>
          Commune
          <input
            required
            name="commune"
            autoComplete="address-level2"
            placeholder="Votre commune"
            maxLength={100}
            value={commune}
            onChange={(e) => setCommune(e.target.value)}
          />
          {fieldError('commune')}
        </label>
      </div>

      <fieldset className="delivery">
        <legend>Mode de livraison</legend>
        <label>
          <input
            type="radio"
            name="mode"
            value="desk"
            checked={!home}
            disabled={!deskAvailable(wilayaCode)}
            onChange={() => setChosenMode('desk')}
          />
          <span>
            Stop Desk <small>Retrait au bureau</small>
          </span>
        </label>
        <label>
          <input type="radio" name="mode" value="home" checked={home} onChange={() => setChosenMode('home')} />
          <span>
            À domicile <small>Chez vous, tout simplement</small>
          </span>
        </label>
      </fieldset>
      {fieldError('mode')}

      {home && (
        <label>
          Adresse de livraison
          <input
            required
            name="address"
            autoComplete="street-address"
            placeholder="Rue, numéro, bâtiment…"
            maxLength={200}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
          {fieldError('address')}
        </label>
      )}

      <div className="quantity-row">
        <span>Quantité</span>
        <div className="quantity">
          <button
            type="button"
            aria-label="Diminuer la quantité"
            disabled={quantity <= 1}
            onClick={() => setQuantity((q) => clampQuantity(q - 1, product.maxQuantity))}
          >
            −
          </button>
          <output aria-live="polite">{quantity}</output>
          <button
            type="button"
            aria-label="Augmenter la quantité"
            disabled={quantity >= product.maxQuantity}
            onClick={() => setQuantity((q) => clampQuantity(q + 1, product.maxQuantity))}
          >
            +
          </button>
        </div>
      </div>
      {fieldError('quantity')}

      <div className="totals">
        <span>
          Livraison <span>{delivery}</span>
        </span>
        <strong>
          Total <span>{total}</span>
        </strong>
      </div>

      <button className="submit" type="submit" disabled={pending}>
        <span>CONFIRMER MA COMMANDE</span>
        <span>
          <ArrowIcon />
        </span>
      </button>
      <p id="status" role="status" aria-live="polite" hidden={status === null}>
        {status}
      </p>
      <p className="payment-note">Paiement à la livraison · الدفع عند الاستلام</p>
      <p className="privacy-note">
        Vos coordonnées servent uniquement au traitement et à la livraison de votre commande.
      </p>
    </form>
  );
}
