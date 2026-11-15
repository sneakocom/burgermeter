#!/usr/bin/env node
// Simulate a retail price change for one product, to test the alert path.
// Usage: node scripts/simulate-change.mjs <productId> <newRetail>
// On the next server start, watchers of that product get an in-app
// notification and the price snapshot updates. Restore with:
//   git checkout data/products.json   (then restart the server)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [idArg, retailArg] = process.argv.slice(2);
const id = Number(idArg);
const newRetail = Number(retailArg);
if (!Number.isInteger(id) || id < 1 || !Number.isFinite(newRetail)) {
  console.error('Usage: node scripts/simulate-change.mjs <productId> <newRetail>');
  process.exit(1);
}
const file = path.join(root, 'data', 'products.json');
const products = JSON.parse(fs.readFileSync(file, 'utf8'));
const idx = id - 1;
if (!products[idx]) { console.error(`No product with id ${id}`); process.exit(1); }
const old = products[idx].retail;
products[idx].retail = newRetail;
fs.writeFileSync(file, JSON.stringify(products, null, 2) + '\n');
console.log(`Product ${id} (${products[idx].name}) retail ${old} -> ${newRetail}. Restart the server to fire alerts.`);
