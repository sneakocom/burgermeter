import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3329;
const base = `http://127.0.0.1:${PORT}`;
let proc;
const tmpDb = path.join(os.tmpdir(), `burgermeter-test-${process.pid}.db`);

before(async () => {
  proc = spawn(process.execPath, ['server.js'], { cwd: path.dirname(new URL(import.meta.url).pathname) + '/..', env: { ...process.env, PORT: String(PORT), DB_PATH: tmpDb }, stdio: 'pipe' });
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(base + '/healthz'); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not start');
});
after(() => { proc?.kill(); try { fs.unlinkSync(tmpDb); } catch {} });

test('healthz counts', async () => {
  const body = await (await fetch(base + '/healthz')).json();
  assert.deepEqual(body, { ok: true, products: 5385, otcProducts: 49 });
});
test('catalog search bustelo', async () => {
  const body = await (await fetch(base + '/api/products?query=bustelo')).json();
  const row = body.products.find((p) => p.name.includes('Bustelo'));
  assert.ok(row); assert.equal(row.cogs, 3.2); assert.ok(row.retail > 0);
});
test('lookup advil verdict', async () => {
  const body = await (await fetch(base + '/api/lookup?upc=305730160407')).json();
  assert.equal(body.found, true); assert.equal(body.product.name, 'Advil');
  assert.equal(body.verdict.kind, 'cheaper-available'); assert.match(body.verdict.cheapestName, /Equate/); assert.equal(body.verdict.saving, 9.38);
});
test('lookup miss records unknown', async () => {
  const body = await (await fetch(base + '/api/lookup?upc=999999999999')).json();
  assert.equal(body.found, false);
});
test('home contains hero stat', async () => {
  const text = await (await fetch(base + '/')).text();
  assert.match(text, /What does it cost to make\?/); assert.match(text, /5,385/);
});
test('blog index lists the seed post', async () => {
  const res = await fetch(base + '/blog');
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /Every product has two prices/); assert.match(text, /href="\/blog\/two-prices"/);
});
test('blog post page renders catalog figures', async () => {
  const res = await fetch(base + '/blog/two-prices');
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /91\.2% margin/); assert.match(text, /\$0\.35/); assert.match(text, /\$3\.99/);
  assert.match(text, /79\.8% margin/); assert.match(text, /72\.9% margin/);
  assert.match(text, /November 15, 2026/);
});
test('unknown blog slug is 404', async () => {
  const res = await fetch(base + '/blog/no-such-post');
  assert.equal(res.status, 404);
});
test('sitemap includes blog urls', async () => {
  const res = await fetch(base + '/sitemap.xml');
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /https:\/\/burgermeter\.com\/blog<\/loc>/); assert.match(text, /https:\/\/burgermeter\.com\/blog\/two-prices/);
});
