# Frikkie's Stock Importer

Unified Shopify-embedded app for 4x4 Factory SA, combining what were three
separate local tools (STEDI Import Manager, Bushdoof Node script, Ultra
Vision Import Manager) plus a new ALTIQ source, into one app that runs
inside the Shopify admin.

## Status

- App shell (auth, nav, dashboard, Postgres/Prisma) — working
- ALTIQ — fetches live from altiq.com.au/products.json (Shopify-hosted
  storefront), stages products. Trade cost from ultradealer.com.au still
  needs matching in manually (password-protected portal).
- Bushdoof — same fetch pattern as ALTIQ works; pricing formula and tag
  taxonomy from the original script still need porting in (see TODOs in
  `app/routes/app.bushdoof.jsx`).
- STEDI / Ultra Vision — placeholder tabs only. Scraper and pricing logic
  from the original standalone apps needs porting in next.

## Local development

```bash
npm install
cp .env.example .env      # fill in SHOPIFY_API_SECRET and DATABASE_URL
npx prisma migrate dev
npm run dev                # opens Shopify CLI, handles the dev tunnel
```

## First-time Shopify Dev Dashboard config

- Client ID: already set in `shopify.app.toml`
- Client Secret: goes in `.env` / Railway env vars only, never committed
- **Use legacy install flow: unchecked** (regular OAuth)
- Scopes: `read_products,write_products,read_inventory,write_inventory,read_online_store_navigation,write_online_store_navigation,read_publications,write_publications`
- App URL + redirect URLs: update in the Dev Dashboard once Railway
  assigns your real domain (placeholders are in `shopify.app.toml`)

## Deploying to Railway

1. Push this repo to GitHub, connect it to your Railway project
2. Add a Postgres plugin in Railway — it gives you a `DATABASE_URL`
3. Set Railway env vars: `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`,
   `SCOPES`, `SHOPIFY_APP_URL` (your Railway domain), `DATABASE_URL`
   (reference the Postgres plugin's), `NODE_ENV=production`
4. Railway will run `npm run docker-start` on deploy, which runs
   `prisma migrate deploy` then starts the server
5. Once you have the Railway domain, update `application_url` and
   `redirect_urls` in `shopify.app.toml` (and in the Dev Dashboard directly)
   to match, then reinstall the app on your store

## Porting order for the remaining sources

1. Ultra Vision (most mature/battle-tested of the three original apps)
2. Bushdoof + ALTIQ together (same Shopify-source fetch pattern already
   scaffolded in `app/adapters/shopifySource.server.js`)
3. STEDI (most involved — Magento scrape + Cloudflare headers + grouped
   product handling)
