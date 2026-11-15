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
  assert.deepEqual(body, { ok: true, products: 10727, otcProducts: 49 });
});
test('catalog search bustelo', async () => {
  const body = await (await fetch(base + '/api/products?query=bustelo')).json();
  const row = body.products.find((p) => p.name.includes('Bustelo'));
  assert.ok(row); assert.equal(row.cogs, 3.2); assert.equal(row.retail, 7.92);
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
  assert.match(text, /What does it cost to make\?/); assert.match(text, /10,727/);
});
