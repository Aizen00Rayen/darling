# Darling storefront clone — design

Date: 2026-11-09
Status: awaiting review

## Goal

Rebuild the live single-page store at https://darling7.store as a Next.js
project that looks and behaves the same, structured so a backend and an
affiliate system can be added to it next.

## Context

- The live site is static, on GitHub Pages: `index.html`, a thank-you page
  `merci.html`, one stylesheet (`styles.css`), one script (`app.js`) and a
  `config.js` holding the price, shade codes and colours, the ingredient
  list, the 58 wilayas and two delivery-rate tables.
- It sells one product, Wet Kiss (3 000 DA, four shades `*01`–`*04`), in
  French, to Algeria, cash on delivery.
- Orders are currently emailed through Web3Forms.
- Decisions made with the owner:
  - Affiliate model (later phase): Darling is the only seller; affiliates get
    a referral link or code and earn commission on attributed orders.
  - The catalog will grow, so product content must be data, not markup.
  - Until the backend exists, the order form posts to a local stub route.

## Success criteria

1. At 1440 px, 768 px and 375 px widths the clone is visually equivalent to
   the live site, section by section.
2. Gallery, shade picker, quantity stepper, wilaya/delivery-mode pricing,
   FAQ accordions, anchor navigation, the mobile sticky buy bar and the
   scroll-triggered videos behave as on the live site (see Behaviour).
3. Submitting a valid order to `/api/orders` redirects to `/merci`;
   invalid input is rejected by the server with field-level errors.
4. Adding a second product requires only a new data entry and assets.
5. `pnpm build`, `pnpm lint` and `pnpm test` pass.

## Stack

- Next.js (App Router), React, TypeScript, pnpm, Node 20.
- Styling: the live stylesheet ported as global CSS with its class names,
  custom properties and breakpoints preserved. No Tailwind.
- Fonts: DM Sans and Space Grotesk (400/500/600/700) via `next/font/google`,
  exposed as the CSS variables the stylesheet expects.
- Images via `next/image`; videos as plain `<video>` elements with the same
  attributes as the live site.
- Validation: `zod`. Tests: Vitest.

## Structure

```
app/
  layout.tsx            fonts, metadata, <html lang="fr">
  page.tsx              renders the default product (Wet Kiss)
  merci/page.tsx        thank-you page ("It's a match.")
  globals.css           ported stylesheet
  api/orders/route.ts   POST stub
components/
  AnnouncementBar.tsx   Header.tsx        Gallery.tsx
  ShadePicker.tsx       OrderForm.tsx     Marquee.tsx
  EffectSection.tsx     LayeringSection.tsx
  RitualSection.tsx     Faq.tsx           FinalCta.tsx   Footer.tsx
  ProductPage.tsx       composes the sections from a Product
data/
  products.ts           Product type + Wet Kiss entry
  delivery.ts           wilayas with home / Stop Desk rates
lib/
  pricing.ts            deliveryFee(), orderTotal()
  order-schema.ts       zod schema shared by form and route
public/assets/          images and videos copied from the live site
```

### Units

- `data/products.ts` — a `Product` has slug, name, tagline, price, shades
  (id, label, swatch image), gallery slides (image or video, caption),
  section copy, ritual steps and FAQ entries (including the ingredient
  list). Everything visible that is specific to Wet Kiss lives here.
- `data/delivery.ts` — an array of `{ code, name, home, desk }` built from
  the live `config.js` tables. `desk` is `null` where the live table has 0,
  which means no Stop Desk service (Tindouf, Bordj Badji Mokhtar, Beni
  Abbes, In Guezzam), never free delivery.
- `lib/pricing.ts` — pure functions: `deliveryFee(wilayaCode, mode)`
  (returns `null` when the mode is unavailable) and
  `orderTotal({ price, quantity, wilayaCode, mode })`. Used by the form for
  display and by the route as the source of truth.
- `lib/order-schema.ts` — fields: product slug, shade code, quantity
  (1–20), full name, phone (spaces stripped, then `0[567]` + 8 digits or
  `+213[567]` + 8 digits), wilaya code, commune, delivery mode
  (`desk` | `home`), address (required when mode is `home`). A `desk` order
  to a wilaya without desk service is invalid.
- Server components by default. Client components: `Gallery`,
  `ShadePicker` + `OrderForm` (they share the selected shade through one
  parent client component), the product videos and the mobile buy bar.

## Behaviour to reproduce

- Gallery: 8 slides (3 photos, the shade comparison, 4 shade renders),
  previous/next with wrap-around, thumbnails, `01 / 08` counter.
- Choosing a shade jumps the gallery to that shade's render; below 700 px
  it also scrolls the gallery into view (respecting reduced motion).
- Quantity stepper clamps to 1–20.
- Delivery line reads "Choisissez une wilaya" until one is chosen. The
  address field appears and is required only for home delivery. Stop Desk
  is disabled, and home selected, for wilayas without desk service.
- Videos load their source only when 20 % visible (mobile file below
  700 px, desktop file otherwise), play muted in a loop, pause off-screen.
- The mobile sticky buy bar hides while the order form is on screen.
- Prices are formatted with `fr-FR` grouping followed by ` DA`.

## Order flow

1. The form validates with the shared schema and shows the delivery fee and
   total from `lib/pricing.ts` as the customer chooses wilaya and mode.
2. On confirm it POSTs JSON to `/api/orders`.
3. The route re-validates, recomputes the total from product and delivery
   data (client-sent prices are ignored), and returns
   `{ ok: true, order: { ...fields, deliveryFee, total } }`.
   Nothing is stored or sent anywhere.
4. Validation failures return 400 with `{ ok: false, errors }` and the form
   shows them next to the fields. Network or 5xx failures, and a 25 s
   timeout, show the live site's French retry messages and keep the
   entered data. The button is disabled while a request is in flight.
5. On success the browser navigates to `/merci`.

The live site's Web3Forms access key is not copied into this project.

## Assets

Copied from darling7.store into `public/assets/` with the same file names:
`darling-logo.png`, `wet-kiss.jpg`, `model.jpg`, `texture.jpg`,
`shade-comparison.png`, `shade-01.png`–`shade-04.png`, `finish.mp4`,
`application.mp4`, and the mobile video variants `finish-mobile.mp4`
(1.8 MB) and `application-mobile.mp4` (5.1 MB): 13 files, about 18.6 MB.

## Testing

- Vitest unit tests for `pricing.ts` (each mode, cheapest and most expensive
  wilaya, quantity scaling, unknown wilaya) and for the order schema
  (required fields, phone format, address required for home delivery).
- Route test: valid order returns the server-computed total; tampered
  client total is ignored; invalid order returns 400.
- Manual visual comparison against the live site at the three widths in
  the success criteria, plus a full order through the form.

## Out of scope

Database and order storage, accounts and authentication, affiliate links,
attribution and commissions, admin screens, online payment, Arabic or
multi-language support, additional products, deployment. Each belongs to
the backend phase and gets its own design.
