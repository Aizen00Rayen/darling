# Darling storefront

Next.js clone of https://darling7.store (Wet Kiss lip gloss, cash on delivery, Algeria),
structured as the base for a backend and affiliate system.

## Commands

```bash
pnpm dev      # http://localhost:3000
pnpm test     # Vitest: data, pricing, validation, orders route
pnpm lint
pnpm build
```

## Where things live

- `data/products.ts` — product content (price, shades, gallery, FAQ). Add products here.
- `data/delivery.ts` — the 58 wilayas with home and Stop Desk rates (`desk: null` = no desk service).
- `lib/pricing.ts`, `lib/order-schema.ts` — totals and validation, shared by the form and the server.
- `app/api/orders/route.ts` — order intake stub. It validates and prices the order but stores nothing;
  the backend plugs in at the marked comment.
- `components/` — page sections. `PurchasePanel` holds the gallery, shade picker and order form.
- `app/globals.css` — the live site's stylesheet, ported with its class names.
- `reference/` — snapshot of the live site's source used for the port (access key redacted).
- `docs/superpowers/` — design spec and implementation plan.
