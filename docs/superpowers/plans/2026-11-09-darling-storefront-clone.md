# Darling Storefront Clone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild https://darling7.store as a Next.js project that looks and behaves the same, with product data separated from markup and orders posted to a local stub route.

**Architecture:** One App Router project. The live stylesheet is ported as global CSS with its class names kept, so markup is transcribed from the live HTML into components. Product and delivery data live in `data/`, pricing and validation in `lib/` as pure functions shared by the order form and the `/api/orders` route.

**Tech Stack:** Next.js (App Router), React, TypeScript, pnpm, zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-09-darling-storefront-clone-design.md`

## Global Constraints

- Node 20, pnpm. No Tailwind. No database, auth, affiliate or payment code.
- `<html lang="fr">`; all visible copy is taken verbatim from the live site.
- Class names, custom properties and breakpoints (700 px mobile breakpoint) from the live `styles.css` are preserved.
- Fonts: DM Sans and Space Grotesk, weights 400/500/600/700, via `next/font/google`.
- The live site's Web3Forms access key must not appear anywhere in the repo, including `reference/`.
- Price 3 000 DA; quantity 1–20; money formatted as `n.toLocaleString('fr-FR') + ' DA'`.
- A desk rate of 0 in the live table means no Stop Desk service, never free delivery.
- Media is copied from darling7.store only: the 13 files listed in the spec.
- Prerequisite: `git config user.name` and `user.email` must be set before any commit step.

## Review Focus

1. Request body to `/api/orders` that is not JSON, or is JSON but not an object: expect 400 with `{ ok: false }`, not a 500. (Task 5)
2. Customer switches to a wilaya without Stop Desk while Stop Desk is selected: mode flips to home, address becomes required, total updates. (Task 7)
3. Phone typed with spaces or in `+213` form (`06 12 34 56 78`, `+213612345678`): accepted and normalised; 9-digit or `08…` numbers rejected. (Task 4)
4. Quantity arriving as a string, decimal, 0 or 21: rejected by the server rather than coerced into a wrong total. (Task 4)
5. Name, commune or address that is only whitespace, or thousands of characters long: rejected (trimmed, 2–120 chars; address up to 200). (Task 4)

---

### Task 1: Scaffold, reference snapshot and assets

**Files:**
- Create: Next.js scaffold in the repo root (`package.json`, `app/`, `tsconfig.json`, `next.config.ts`, `eslint.config.mjs`)
- Create: `vitest.config.ts`
- Create: `reference/index.html`, `reference/merci.html`, `reference/styles.css`, `reference/app.js`, `reference/config.js`
- Create: `public/assets/` with the 13 media files

**Interfaces:**
- Produces: `pnpm test` (Vitest, `@/` alias to the repo root), `pnpm lint`, `pnpm build`; `reference/` as the source of truth for markup, CSS and copy in Tasks 2, 6 and 7.

- [ ] **Step 1:** Run `pnpm create next-app@latest . --ts --app --eslint --no-tailwind --no-src-dir --import-alias "@/*" --use-pnpm --turbopack`. Delete the starter content of `app/page.tsx`, `app/page.module.css` and the default `public/*.svg`.
- [ ] **Step 2:** `pnpm add zod` and `pnpm add -D vitest`. Add `vitest.config.ts` with `environment: 'node'` and the `@` alias; add `"test": "vitest run"` to `package.json`.
- [ ] **Step 3:** Save the five live source files into `reference/` with `curl`. In `reference/config.js` replace the `accessKey` value with `"REDACTED"`. Verify: `grep -c REDACTED reference/config.js` prints 1 and the original key string appears nowhere (`git grep` after staging).
- [ ] **Step 4:** Download into `public/assets/`: `darling-logo.png`, `wet-kiss.jpg`, `model.jpg`, `texture.jpg`, `shade-comparison.png`, `shade-01.png`…`shade-04.png`, `finish.mp4`, `finish-mobile.mp4`, `application.mp4`, `application-mobile.mp4` from `https://darling7.store/assets/`. Verify: 13 files, `du -sh public/assets` about 18–19 MB, `file` reports image/video types (not HTML error pages).
- [ ] **Step 5:** Run `pnpm build`. Expected: succeeds.
- [ ] **Step 6:** Commit: `chore: scaffold Next.js project with reference snapshot and assets`.

### Task 2: Delivery and product data

**Files:**
- Create: `data/delivery.ts`, `data/products.ts`
- Test: `data/delivery.test.ts`, `data/products.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // data/delivery.ts
  export type DeliveryMode = 'desk' | 'home';
  export type Wilaya = { code: number; name: string; home: number; desk: number | null };
  export const wilayas: Wilaya[];                       // code 1..58, in order
  export function getWilaya(code: number): Wilaya | undefined;

  // data/products.ts
  export type Shade = { code: string; color: string; image: string };
  export type Slide = { src: string; alt: string };
  export type Faq = { title: string; body: string };
  export type Product = {
    slug: string; name: string; price: number; maxQuantity: number;
    shades: Shade[]; slides: Slide[]; ingredients: string; faqs: Faq[];
  };
  export const products: Product[];
  export const defaultProduct: Product;                 // Wet Kiss
  export function getProduct(slug: string): Product | undefined;
  ```

- [ ] **Step 1: Write failing tests**
  ```ts
  // data/delivery.test.ts
  expect(wilayas).toHaveLength(58);
  expect(wilayas.map(w => w.code)).toEqual(Array.from({ length: 58 }, (_, i) => i + 1));
  expect(getWilaya(16)).toEqual({ code: 16, name: 'Alger', home: 450, desk: 300 });
  expect(getWilaya(1)).toMatchObject({ name: 'Adrar', home: 1650, desk: 850 });
  expect(wilayas.filter(w => w.desk === null).map(w => w.name))
    .toEqual(['Tindouf', 'Bordj Badji Mokhtar', 'Beni Abbes', 'In Guezzam']);
  expect(wilayas.every(w => w.home > 0 && (w.desk === null || w.desk > 0))).toBe(true);
  expect(getWilaya(59)).toBeUndefined();

  // data/products.test.ts
  expect(defaultProduct).toMatchObject({ slug: 'wet-kiss', name: 'Wet Kiss', price: 3000, maxQuantity: 20 });
  expect(defaultProduct.shades.map(s => s.code)).toEqual(['*01', '*02', '*03', '*04']);
  expect(defaultProduct.shades.map(s => s.color)).toEqual(['#fdecdd', '#f79797', '#bc5938', '#ff0000']);
  expect(defaultProduct.slides).toHaveLength(8);
  expect(defaultProduct.slides[4].src).toBe('/assets/shade-01.png');
  expect(defaultProduct.ingredients.startsWith('Diisostearyl Malate')).toBe(true);
  expect(defaultProduct.faqs).toHaveLength(3);
  expect(getProduct('nope')).toBeUndefined();
  ```
- [ ] **Step 2:** Run `pnpm test`. Expected: FAIL (modules missing).
- [ ] **Step 3:** Implement both files. Wilaya names and the `domicile`/`bureau` tables come from `reference/config.js` (index i → code i+1; `bureau` 0 → `desk: null`). Slides follow the order built in `reference/app.js` (3 photos, comparison, 4 shade renders) with its alt texts. FAQ titles and bodies come from the three `<details>` in `reference/index.html`.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: add delivery and product data`.

### Task 3: Pricing

**Files:**
- Create: `lib/pricing.ts`
- Test: `lib/pricing.test.ts`

**Interfaces:**
- Consumes: `getWilaya`, `DeliveryMode` from Task 2.
- Produces:
  ```ts
  export function formatMoney(n: number): string;
  export function deliveryFee(wilayaCode: number, mode: DeliveryMode): number | null; // null = unknown wilaya or mode unavailable
  export function orderTotal(input: { price: number; quantity: number; wilayaCode: number; mode: DeliveryMode }): number | null;
  ```

- [ ] **Step 1: Write failing tests**
  ```ts
  expect(formatMoney(3000).replace(/\s/g, ' ')).toBe('3 000 DA');
  expect(deliveryFee(16, 'home')).toBe(450);
  expect(deliveryFee(16, 'desk')).toBe(300);
  expect(deliveryFee(56, 'home')).toBe(2000);          // Djanet, most expensive
  expect(deliveryFee(37, 'desk')).toBeNull();          // Tindouf: no desk
  expect(deliveryFee(37, 'home')).toBe(1650);
  expect(deliveryFee(99, 'home')).toBeNull();
  expect(orderTotal({ price: 3000, quantity: 1, wilayaCode: 16, mode: 'desk' })).toBe(3300);
  expect(orderTotal({ price: 3000, quantity: 3, wilayaCode: 16, mode: 'home' })).toBe(9450); // fee charged once
  expect(orderTotal({ price: 3000, quantity: 1, wilayaCode: 37, mode: 'desk' })).toBeNull();
  ```
- [ ] **Step 2:** Run `pnpm test lib/pricing`. Expected: FAIL.
- [ ] **Step 3:** Implement the three functions.
- [ ] **Step 4:** Run `pnpm test lib/pricing`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: add pricing functions`.

### Task 4: Order schema

**Files:**
- Create: `lib/order-schema.ts`
- Test: `lib/order-schema.test.ts`

**Interfaces:**
- Consumes: `getProduct` (Task 2), `getWilaya` (Task 2).
- Produces:
  ```ts
  export const orderSchema: z.ZodType<OrderInput>;
  export type OrderInput = {
    productSlug: string; shadeCode: string; quantity: number;
    fullName: string; phone: string;            // normalised, no spaces
    wilayaCode: number; commune: string;
    mode: DeliveryMode; address?: string;
  };
  export type FieldErrors = Partial<Record<keyof OrderInput, string>>;
  export function parseOrder(data: unknown):
    | { ok: true; order: OrderInput }
    | { ok: false; errors: FieldErrors };       // French messages, first error per field
  ```
  Phone error copy (from the live site): `Saisissez un numéro algérien valide (10 chiffres ou +213).`

- [ ] **Step 1: Write failing tests.** With `valid = { productSlug: 'wet-kiss', shadeCode: '*02', quantity: 2, fullName: 'Amel B', phone: '0612345678', wilayaCode: 16, commune: 'Hydra', mode: 'desk' }`:
  ```ts
  expect(parseOrder(valid)).toEqual({ ok: true, order: valid });
  expect(parseOrder({ ...valid, phone: '06 12 34 56 78' })).toMatchObject({ ok: true, order: { phone: '0612345678' } });
  expect(parseOrder({ ...valid, phone: '+213612345678' }).ok).toBe(true);
  for (const phone of ['061234567', '0812345678', '+21361234567', 'abc']) expectError({ ...valid, phone }, 'phone');
  for (const quantity of [0, 21, 1.5, '2']) expectError({ ...valid, quantity }, 'quantity');
  expectError({ ...valid, fullName: '   ' }, 'fullName');
  expectError({ ...valid, commune: 'x'.repeat(121) }, 'commune');
  expectError({ ...valid, productSlug: 'nope' }, 'productSlug');
  expectError({ ...valid, shadeCode: '*09' }, 'shadeCode');
  expectError({ ...valid, wilayaCode: 59 }, 'wilayaCode');
  expectError({ ...valid, mode: 'home' }, 'address');                       // address required for home
  expect(parseOrder({ ...valid, mode: 'home', address: '12 rue Didouche' }).ok).toBe(true);
  expectError({ ...valid, mode: 'home', address: 'x'.repeat(201) }, 'address');
  expectError({ ...valid, wilayaCode: 37, mode: 'desk' }, 'mode');          // Tindouf has no desk
  expect(parseOrder(null).ok).toBe(false);
  expect(parseOrder('text').ok).toBe(false);
  ```
  where `expectError(data, field)` asserts `ok === false` and `errors[field]` is a non-empty string.
- [ ] **Step 2:** Run `pnpm test lib/order-schema`. Expected: FAIL.
- [ ] **Step 3:** Implement with zod: strings trimmed, 2–120 chars (address 5–200); phone stripped of whitespace then matched against `^(?:0[567]\d{8}|\+213[567]\d{8})$`; quantity `z.number().int().min(1).max(20)` with no coercion; cross-field checks in `superRefine`.
- [ ] **Step 4:** Run `pnpm test lib/order-schema`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: add order validation schema`.

### Task 5: Orders API stub

**Files:**
- Create: `app/api/orders/route.ts`
- Test: `app/api/orders/route.test.ts`

**Interfaces:**
- Consumes: `parseOrder` (Task 4), `orderTotal`, `deliveryFee` (Task 3), `getProduct` (Task 2).
- Produces: `POST /api/orders`
  - 200 `{ ok: true, order: OrderInput & { unitPrice: number; deliveryFee: number; total: number } }`
  - 400 `{ ok: false, errors: FieldErrors }` (empty `errors` when the body is not a JSON object)
  - Stores and sends nothing.

- [ ] **Step 1: Write failing tests** calling the exported `POST` with a `Request`:
  ```ts
  // valid order, Alger desk, quantity 2
  expect(res.status).toBe(200);
  expect(body).toMatchObject({ ok: true, order: { unitPrice: 3000, deliveryFee: 300, total: 6300 } });
  // client-sent prices are ignored
  post({ ...valid, total: 1, unitPrice: 1, deliveryFee: 0 })  → total 6300
  // invalid field
  post({ ...valid, phone: '123' }) → 400, body.errors.phone defined
  // malformed bodies
  post raw 'not json' → 400 { ok: false, errors: {} }
  post raw '[]'       → 400, ok false
  ```
- [ ] **Step 2:** Run `pnpm test app/api`. Expected: FAIL.
- [ ] **Step 3:** Implement `export async function POST(request: Request): Promise<Response>`; `request.json()` wrapped in try/catch.
- [ ] **Step 4:** Run `pnpm test app/api`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: add /api/orders stub route`.

### Task 6: Styles, layout, static sections and thank-you page

**Files:**
- Modify: `app/layout.tsx`, `app/globals.css`, `app/page.tsx`
- Create: `app/merci/page.tsx`
- Create: `components/AnnouncementBar.tsx`, `Header.tsx`, `Marquee.tsx`, `EffectSection.tsx`, `LayeringSection.tsx`, `RitualSection.tsx`, `Faq.tsx`, `FinalCta.tsx`, `Footer.tsx`, `ProductPage.tsx`

**Interfaces:**
- Consumes: `Product`, `defaultProduct` (Task 2).
- Produces: `ProductPage({ product }: { product: Product })` rendering every section in live order, with a slot where Task 7's `PurchasePanel` and `ProductVideo` go; `Faq({ faqs }: { faqs: Faq[] })`.

- [ ] **Step 1:** Replace `app/globals.css` with `reference/styles.css`. Change only: asset URLs to `/assets/...`, and font-family declarations to use `var(--font-dm-sans)` / `var(--font-space-grotesk)`.
- [ ] **Step 2:** In `app/layout.tsx` load both fonts with `next/font/google` (weights 400–700, variables `--font-dm-sans`, `--font-space-grotesk`), set `lang="fr"`, and copy title, description and other `<head>` metadata from `reference/index.html` into `metadata`. Include the "Aller au produit" skip link.
- [ ] **Step 3:** Transcribe each static section of `reference/index.html` into its component, keeping element structure, class names, ids (`#produit`, `#effet`, `#rituel`, `#commande`) and copy. Product-specific values (name, price, ingredients, FAQ entries) come from the `product` prop. Footer year is `new Date().getFullYear()`. Images use `next/image` with intrinsic sizes from the files; the hero image gets `priority`.
- [ ] **Step 4:** Build `app/merci/page.tsx` from `reference/merci.html` (copy: "MERCI, DARLING", "It’s a match.", three lines of text, link "RETOUR À WET KISS" to `/`).
- [ ] **Step 5:** `app/page.tsx` renders `<ProductPage product={defaultProduct} />`.
- [ ] **Step 6:** Run `pnpm lint && pnpm build`. Expected: both pass. Run `pnpm dev` and confirm `/` and `/merci` render with no console errors and the static sections match the live site at 1440 px.
- [ ] **Step 7:** Commit: `feat: port styles, layout, static sections and thank-you page`.

### Task 7: Interactive purchase panel, videos and mobile buy bar

**Files:**
- Create: `components/PurchasePanel.tsx` (client; owns `shadeIndex`, `slideIndex`, `quantity`), `components/Gallery.tsx`, `components/ShadePicker.tsx`, `components/OrderForm.tsx`, `components/ProductVideo.tsx`, `components/MobileBuyBar.tsx`
- Create: `lib/order-form-state.ts`
- Test: `lib/order-form-state.test.ts`
- Modify: `components/ProductPage.tsx`

**Interfaces:**
- Consumes: `Product`, `wilayas`, `getWilaya`, `deliveryFee`, `orderTotal`, `formatMoney`, `parseOrder`, `POST /api/orders`.
- Produces:
  ```ts
  // lib/order-form-state.ts — pure, so the form's rules are unit-tested
  export function resolveMode(wilayaCode: number | null, mode: DeliveryMode): DeliveryMode; // 'home' when the wilaya has no desk
  export function deskAvailable(wilayaCode: number | null): boolean;                        // true when no wilaya chosen
  export function clampQuantity(n: number, max: number): number;
  export function wrapIndex(i: number, length: number): number;
  export function summary(input: { price: number; quantity: number; wilayaCode: number | null; mode: DeliveryMode }):
    { delivery: string; total: string };  // delivery is 'Choisissez une wilaya' when wilayaCode is null
  ```

- [ ] **Step 1: Write failing tests**
  ```ts
  expect(resolveMode(37, 'desk')).toBe('home');
  expect(resolveMode(16, 'desk')).toBe('desk');
  expect(resolveMode(null, 'desk')).toBe('desk');
  expect(deskAvailable(37)).toBe(false);
  expect(deskAvailable(null)).toBe(true);
  expect(clampQuantity(0, 20)).toBe(1);
  expect(clampQuantity(21, 20)).toBe(20);
  expect(wrapIndex(-1, 8)).toBe(7);
  expect(wrapIndex(8, 8)).toBe(0);
  expect(summary({ price: 3000, quantity: 1, wilayaCode: null, mode: 'desk' }).delivery).toBe('Choisissez une wilaya');
  expect(norm(summary({ price: 3000, quantity: 1, wilayaCode: null, mode: 'desk' }).total)).toBe('3 000 DA');
  expect(norm(summary({ price: 3000, quantity: 2, wilayaCode: 16, mode: 'home' }).total)).toBe('6 450 DA');
  ```
- [ ] **Step 2:** Run `pnpm test lib/order-form-state`. Expected: FAIL.
- [ ] **Step 3:** Implement `lib/order-form-state.ts`. Run the tests. Expected: PASS.
- [ ] **Step 4:** Build `Gallery`, `ShadePicker` and `OrderForm` from the hero markup in `reference/index.html` and the behaviour in `reference/app.js`, wired through `PurchasePanel`:
  - Gallery: prev/next with `wrapIndex`, thumbnails with `aria-pressed`, counter `01 / 08`, class `shade-photo` on the hero when index ≥ 3.
  - Choosing shade *i* sets slide `i + 4`; below 700 px scrolls `.gallery` into view (`instant` under reduced motion).
  - Form: wilaya options `01 — Adrar`…; address field shown and required only for home; Stop Desk radio disabled per `deskAvailable`; changing wilaya applies `resolveMode`; stepper disables at 1 and at `maxQuantity`.
  - Submit: validate with `parseOrder`, show field errors; POST JSON with a 25 s `AbortController` timeout; button disabled and `aria-busy` while pending; on `ok` `router.push('/merci')`; on 400 show returned errors; on timeout / failure show the two French status messages from `reference/app.js` and keep the entered data.
- [ ] **Step 5:** Build `ProductVideo({ desktop, mobile, poster, label })`: no `src` until 20 % visible, then mobile file below 700 px else desktop; muted, loop, playsInline; pause when off-screen. Build `MobileBuyBar` showing the selected shade code and toggling class `in-form` while `#commande` intersects (threshold 0.05).
- [ ] **Step 6:** Mount `PurchasePanel`, both `ProductVideo`s and `MobileBuyBar` in `ProductPage`.
- [ ] **Step 7:** Run `pnpm lint && pnpm test && pnpm build`. Expected: all pass.
- [ ] **Step 8:** Commit: `feat: add gallery, shade picker, order form, videos and mobile buy bar`.

### Task 8: Verification against the live site

**Files:**
- Modify: whichever component or CSS a difference is found in.

- [ ] **Step 1:** With `pnpm dev` running, compare `http://localhost:3000` with `https://darling7.store` at 1440, 768 and 375 px, section by section (top bar, header, hero, marquee, effect, layering, ritual, FAQ, final CTA, footer, `/merci`). Fix any differences.
- [ ] **Step 2:** Exercise in the browser: all 8 slides both directions; each shade; quantity 1 → 20 → 1; Alger desk (total 3 300 DA) and home (3 450 DA); Tindouf (desk disabled, home forced, 4 650 DA); invalid phone shows the French message; a valid order lands on `/merci`; stopping the dev server mid-submit shows the failure message and keeps the data.
- [ ] **Step 3:** Run `pnpm lint && pnpm test && pnpm build`. Expected: all pass, no console errors on either page.
- [ ] **Step 4:** Confirm `git grep -i "web3forms"` finds nothing outside `docs/` and `reference/`, and the access key is absent everywhere.
- [ ] **Step 5:** Commit: `fix: visual and behavioural parity with live site`.
