'use client';

import { useRouter } from 'next/navigation';
import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { wilayas, type DeliveryMode } from '@/data/delivery';
import type { Product } from '@/data/products';
import { clampQuantity, deskAvailable, resolveMode, summary } from '@/lib/order-form-state';
import { useHydrated } from '@/lib/auth/use-hydrated';
import { parseOrder, type FieldErrors, type OrderInput } from '@/lib/order-schema';
import { hasHiddenErrors, submitOrder } from '@/lib/submit-order';
import { ArrowIcon, AsteriskIcon } from './icons';

const TIMEOUT_MS = 25_000;
const TIMEOUT_MESSAGE =
  'La confirmation prend trop de temps. Vérifiez votre connexion avant de réessayer ; votre demande a peut-être été reçue.';
const RATE_LIMIT_MESSAGE =
  'Trop de commandes ont été envoyées depuis cette connexion ou avec ce numéro. Réessayez dans un moment, ou contactez-nous directement.';
const FAILURE_MESSAGE =
  'La commande n’a pas pu être confirmée. Vos informations sont conservées dans le formulaire ; veuillez réessayer.';

export const ORDER_FORM_ID = 'commande';

/** Fields that render their own error message. Errors on any other field fall back to the status line. */
const SHOWN_FIELDS: readonly (keyof OrderInput)[] = [
  'fullName',
  'phone',
  'wilayaCode',
  'commune',
  'mode',
  'address',
  'quantity',
];

type Props = { product: Product; shadeCode: string };

export function OrderForm({ product, shadeCode }: Props) {
  const router = useRouter();
  // False on the server and while hydrating: the submit button stays disabled until the handler below exists, so a
  // click cannot fall back to a native submit that would carry the customer's name and phone in the URL.
  const hydrated = useHydrated();
  const phoneRef = useRef<HTMLInputElement>(null);
  const resetOnHide = useRef(false);

  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [wilayaCode, setWilayaCode] = useState<number | null>(null);
  const [commune, setCommune] = useState('');
  const [chosenMode, setChosenMode] = useState<DeliveryMode>('desk');
  const [address, setAddress] = useState('');
  const [quantity, setQuantity] = useState(1);
  // Honeypot: invisible to people, tempting to bots. Anything typed here makes the server drop the order silently.
  const [website, setWebsite] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Next keeps this page mounted (hidden) after navigating to /merci. Without a
  // reset, coming back would show the sent order with a disabled submit button.
  useLayoutEffect(() => {
    return () => {
      if (!resetOnHide.current) return;
      resetOnHide.current = false;
      setFullName('');
      setPhone('');
      setWilayaCode(null);
      setCommune('');
      setChosenMode('desk');
      setAddress('');
      setQuantity(1);
      setWebsite('');
      setErrors({});
      setStatus(null);
      setPending(false);
    };
  }, []);

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
      // The phone error is shown the way the live site shows it: as the
      // browser's validation bubble on the field, not as inline text.
      const { phone: phoneError, ...otherErrors } = parsed.errors;
      setErrors(otherErrors);
      if (phoneError && phoneRef.current) {
        phoneRef.current.setCustomValidity(phoneError);
        phoneRef.current.reportValidity();
      }
      return;
    }

    setErrors({});
    setStatus('Envoi de votre commande…');
    setPending(true);
    const result = await submitOrder(parsed.order, { fetch: window.fetch.bind(window), timeoutMs: TIMEOUT_MS, honeypot: website });
    if (result.kind === 'ok') {
      resetOnHide.current = true;
      router.push(result.number ? `/merci?n=${encodeURIComponent(result.number)}` : '/merci');
      return;
    }
    if (result.kind === 'invalid') {
      setErrors(result.errors);
      setStatus(hasHiddenErrors(result.errors, SHOWN_FIELDS) ? FAILURE_MESSAGE : null);
    } else if (result.kind === 'rate_limited') {
      setStatus(RATE_LIMIT_MESSAGE);
    } else {
      setStatus(result.kind === 'timeout' ? TIMEOUT_MESSAGE : FAILURE_MESSAGE);
    }
    setPending(false);
  }

  return (
    <form id={ORDER_FORM_ID} className="order glass" method="post" onSubmit={onSubmit} aria-busy={pending || undefined}>
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
          {fieldError('phone')}
        </label>
        <label>
          Wilaya
          <select
            name="wilayaCode"
            required
            value={wilayaCode ?? ''}
            onChange={(e) => {
              const code = e.target.value ? Number(e.target.value) : null;
              setWilayaCode(code);
              // As on the live site, a forced switch to home delivery sticks.
              setChosenMode((current) => resolveMode(code, current));
            }}
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

      <div className="hp-field" aria-hidden="true">
        <label>
          Site web
          <input
            type="text"
            name="website"
            tabIndex={-1}
            autoComplete="off"
            aria-hidden="true"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
          />
        </label>
      </div>

      <button className="submit" type="submit" disabled={pending || !hydrated}>
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
