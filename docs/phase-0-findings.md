# Phase 0 findings (2026-11-16)

Inputs for the new brand homepage, stock management and UI/UX plan. Nothing here changes code.

## Current state

- `/` renders `ProductPage` with the default product (Wet Kiss). `darling.spectraagency.tech` is a single product page: nav is only anchors (Wet Kiss, L'effet gloss, Le rituel) plus a "Je le veux" button. No shop, no catalogue, no about/FAQ page.
- The storefront was cloned from `darling7.store` (an Algerian one-product page, Wet Kiss 3 000 DA, 4 shades, COD, French), not from hidarling.com. The product page at `/produit/[slug]` stays as is.
- Stock: `products.stock` is one integer per product (migration 0004). No code in `server/orders` or `lib` reads or changes it, shades are not tracked, and the admin dashboard bar uses a hardcoded max of 100. A `stock.write` permission and an order `source` field (website, affiliate, instagram, whatsapp, facebook, direct, other) already exist.

## Current brand tokens (keep)

- `--pink #ed007d`, `--paper #fff6fa`, `--ink #24141c`, `--line #e8ccd9`; DM Sans (body) and Space Grotesk (headings). Defined in `ui/tokens.css` and `app/globals.css`.

## hidarling.com (mother site)

- Look: black on white with hot pink (`rgb(217,1,122)`), uppercase, square buttons, proprietary font Brutal Type (not reusable; keep DM Sans / Space Grotesk).
- Nav: Skincare, Makeup, Fragrance, Bath&Body, Accessories, Sets; header row #DARLINGJOURNAL, About, FAQ, Where to buy; search.
- Hero copy: "DARLING, celebrate playful beauty, self-expression and iconic moments — all with your favourite brand by your side!"
- Sections: New carousel, About Darling, #DARLINGJOURNAL, For you (Home Spa, Travel Essentials, Self-Care Break, Party Glow, Romantic Weekend), Bestsellers, mask quiz ("MATCH ME UP"), FAQ, newsletter ("LET'S BE FRIENDS").
- FAQ topics: where to buy, cruelty-free, vegan, parabens, where made (masks and patches Korea, blushes and glosses Italy, lip balm and brow marker Germany, fragrances France), restock, becoming a retailer, contact.
- No prices, no reviews on the pages read.
- Assets: logo `https://hidarling.com/images/dark-logo-lg.svg`; product images under `https://api.hidarling.com/storage/product/`.
- Already in the repo: `public/assets` has the logo, Wet Kiss photos, 4 shade images, texture/model images and videos.

## Open decisions (need the owner)

1. Rights to reuse hidarling.com copy and product images as the Algerian distributor.
2. Product list to sell beyond Wet Kiss, with prices and stock counts (the mother site has about 80 products; none are invented here).
3. Language: French only, or French plus Arabic (RTL) at launch.
4. How off-site sales are recorded today, and opening stock per product/shade.
5. Delivery coverage, timing, fees and return policy wording for the homepage.
6. Algerian contact details for the footer.
