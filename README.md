# BurgerMeter

What it costs to make vs what you pay.

BurgerMeter is a pricing-transparency catalog. It compares a theorized
manufacturing COGS (cost of goods sold) against the retail price for
10,727 products, and it groups over-the-counter medicines with the same
active ingredients and strength in the Identicals section.

Live brand home (deployment is handled separately): burgermeter.com

## Run

Requirements: Node 24 (uses the built-in `node:sqlite`; zero npm
dependencies, no build step).

```bash
npm start
# PORT=3220 node server.js   (default port 3220)
```

Open http://localhost:3220/

Run the tests:

```bash
npm test
```

Health check: `GET /healthz` returns
`{"ok":true,"products":10727,"otcProducts":49}`.

## What is in the app

- `/` Catalog with search (word-by-word, any order, punctuation ignored),
  a 21-category filter, sorting, and paginated results through
  `/api/products?query=&category=&sort=&page=&pageSize=`.
- `/product/:id` Detail page with COGS/retail, margin, cost breakdown,
  an observed retailer price grid (Walmart, Target, Kroger, Amazon), and
  a price-history chart.
- `/identicals` One table per group of OTC products with the same active
  ingredients and strength, ranked by price per dose, plus a
  Check-a-product tool (manual UPC, name search, and camera scan via
  ZXing as progressive enhancement; manual entry always works).
- `/watchlist` Register, sign in, sign out (scrypt password hashes,
  httpOnly session cookie), a watchlist, and in-app alerts.
- `/methodology` How the numbers work.
- `/blog` Blog index, newest first, and `/blog/:slug` post pages. Posts
  are `.mjs` files in `blog/`, one file per post, each default-exporting
  `{ slug, title, date, excerpt, body }` (body is an HTML string). The
  server loads them at startup, so adding a post is adding a file and
  restarting. `/sitemap.xml` is generated from the same list.
- APIs: `/api/lookup?upc=`, `/api/otc-search?q=`, `/api/me`,
  `/api/register`, `/api/signin`, `/api/signout`, `/api/watch`,
  `/api/watchlist`, `/api/notifications`.

Production install uses the `burgermeter.service` systemd unit template
(User=deploy, WorkingDirectory=/home/deploy/apps/burgermeter,
PORT=3220).

## Data sources and honesty rules

- `data/products.json` — the 10,727-product catalog ported from the
  COGS Account Prototype. Each product has a theorized COGS split into
  three buckets (ingredients or parts, packaging, labor), a retail
  price, and a price history. Product ids are assigned by array order
  starting at 1. COGS figures are theorized estimates, not a
  manufacturer's profit statement.
- `data/identicals.json` — the prototype's `listidenticals` output:
  12 merged tables, 49 OTC products. Active ingredients, strength,
  dosage form and labeler come from DailyMed (source link on every
  row). Wording rule: always "same active ingredients and strength",
  never "identical medicine". Inactive ingredients can differ, and the
  page states this is price information, not medical advice.
- `data/retailer-prices.json` — observed retailer prices only, dated
  and sourced. Exactly 4 verified rows exist (Walmart, 2026-11-02,
  "Walmart screenshot", for product ids 1–4). Retailers with no
  observation display "Not checked yet"; nothing is invented.
- Prices are rechecked every two weeks. A product with a single history
  point is labelled "First snapshot".

The local SQLite database (`burgermeter.db`) holds users, sessions,
watchlist, notifications, price snapshots and unknown UPCs. It is
gitignored and is not shipped.

## Alerts and simulate-change

On startup the server compares `data/products.json` against the
`price_snapshots` table. The first run only seeds snapshots. On later
runs, every changed product creates one in-app notification per
watching user (per changed field) and updates the snapshot.

To test the alert path end to end:

```bash
node scripts/simulate-change.mjs 3 8.50   # product 3 retail -> 8.50
# restart the server; watchers of product 3 now have a notification
git checkout data/products.json           # restore the real price
# restart again so the snapshot returns to the real price
```

## Out of scope

Email alerts are explicitly out of scope. Alerts are in-app only.
No secrets belong in this repo; the database file and any `.env` are
gitignored.
