import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3220);
const HOST = process.env.HOST || '127.0.0.1';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'burgermeter.db');
const RETAILERS = ['Walmart', 'Target', 'Kroger', 'Amazon'];
const ZXING_URL = 'https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/umd/zxing-browser.min.js';

// ---------- Data ----------
function loadProducts() {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'products.json'), 'utf8'));
  return raw.map((p, i) => ({ ...p, id: i + 1 }));
}
let products = loadProducts();
const productsById = () => new Map(products.map((p) => [p.id, p]));
const identicals = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'identicals.json'), 'utf8'));
const retailerPricesRaw = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'retailer-prices.json'), 'utf8'));
const categories = [...new Set(products.map((p) => p.category))].sort();
const avgMargin = products.reduce((s, p) => s + (p.retail ? ((p.retail - p.cogs) / p.retail) * 100 : 0), 0) / products.length;
const allOtc = identicals.groups.flatMap((g) => g.products);

// ---------- DB ----------
const db = new DatabaseSync(DB_PATH);
db.exec(`
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS watchlist (user_id INTEGER NOT NULL, product_id INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (user_id, product_id));
CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, product_id INTEGER NOT NULL, field TEXT NOT NULL, old_value REAL, new_value REAL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS price_snapshots (product_id INTEGER PRIMARY KEY, retail REAL, cogs REAL);
CREATE TABLE IF NOT EXISTS unknown_upcs (id INTEGER PRIMARY KEY AUTOINCREMENT, upc TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
`);

// ---------- Alerts engine: compare on startup ----------
function runPriceCheck() {
  products = loadProducts();
  const countRow = db.prepare('SELECT COUNT(*) AS n FROM price_snapshots').get();
  if (!countRow || countRow.n === 0) {
    const ins = db.prepare('INSERT INTO price_snapshots (product_id, retail, cogs) VALUES (?, ?, ?)');
    db.exec('BEGIN');
    try { for (const p of products) ins.run(p.id, p.retail, p.cogs); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
    return { seeded: true, changed: 0 };
  }
  let changed = 0;
  db.exec('BEGIN');
  try {
  const getSnap = db.prepare('SELECT retail, cogs FROM price_snapshots WHERE product_id = ?');
  const updSnap = db.prepare('INSERT INTO price_snapshots (product_id, retail, cogs) VALUES (?, ?, ?) ON CONFLICT(product_id) DO UPDATE SET retail=excluded.retail, cogs=excluded.cogs');
  const watchers = db.prepare('SELECT user_id FROM watchlist WHERE product_id = ?');
  const insNotif = db.prepare('INSERT INTO notifications (user_id, product_id, field, old_value, new_value) VALUES (?, ?, ?, ?, ?)');
  for (const p of products) {
    const snap = getSnap.get(p.id);
    if (!snap) { updSnap.run(p.id, p.retail, p.cogs); continue; }
    const diffs = [];
    if (Number(snap.retail) !== Number(p.retail)) diffs.push(['retail', snap.retail, p.retail]);
    if (Number(snap.cogs) !== Number(p.cogs)) diffs.push(['cogs', snap.cogs, p.cogs]);
    if (diffs.length) {
      changed++;
      const users = watchers.all(p.id);
      for (const u of users) for (const [field, oldV, newV] of diffs) insNotif.run(u.user_id, p.id, field, oldV, newV);
      updSnap.run(p.id, p.retail, p.cogs);
    }
  }
  db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { seeded: false, changed };
}
const startupCheck = runPriceCheck();

// ---------- Helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '$' + Number(n).toFixed(2);
const marginOf = (p) => (p.retail ? ((p.retail - p.cogs) / p.retail) * 100 : 0);
function normalizeWords(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean); }
function matchesQuery(p, query) {
  const tokens = normalizeWords(query);
  if (!tokens.length) return true;
  const hay = normalizeWords(`${p.name} ${p.category} ${p.sub} ${p.detail || ''}`).join(' ');
  return tokens.every((t) => hay.includes(t));
}
function sortProducts(list, sort) {
  const arr = [...list];
  const byName = (a, b) => a.name.localeCompare(b.name);
  switch (sort) {
    case 'margin-desc': arr.sort((a, b) => marginOf(b) - marginOf(a) || byName(a, b)); break;
    case 'margin-asc': arr.sort((a, b) => marginOf(a) - marginOf(b) || byName(a, b)); break;
    case 'retail-desc': arr.sort((a, b) => b.retail - a.retail || byName(a, b)); break;
    case 'retail-asc': arr.sort((a, b) => a.retail - b.retail || byName(a, b)); break;
    case 'cogs-desc': arr.sort((a, b) => b.cogs - a.cogs || byName(a, b)); break;
    case 'cogs-asc': arr.sort((a, b) => a.cogs - b.cogs || byName(a, b)); break;
    default: arr.sort(byName);
  }
  return arr;
}
function retailerGrid(productId) {
  const observed = retailerPricesRaw[String(productId)] || [];
  const byRetailer = new Map(observed.map((o) => [o.retailer, o]));
  const checked = [];
  const unchecked = [];
  for (const r of RETAILERS) {
    const row = byRetailer.get(r);
    if (row) checked.push({ retailer: r, price: row.price, checkedAt: row.checkedAt, sourceLabel: row.sourceLabel, sourceUrl: row.sourceUrl, checked: true });
    else unchecked.push({ retailer: r, price: null, checkedAt: null, sourceLabel: null, sourceUrl: null, checked: false });
  }
  checked.sort((a, b) => a.price - b.price);
  const prices = checked.map((c) => c.price);
  const savingsVsHighest = prices.length >= 2 ? Math.round((Math.max(...prices) - Math.min(...prices)) * 100) / 100 : null;
  return { grid: [...checked, ...unchecked], savingsVsHighest };
}
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, expected) {
  const { hash } = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expected, 'hex'));
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) { const [k, ...v] = part.trim().split('='); if (k) out[k] = v.join('='); }
  return out;
}
function currentUser(req) {
  const token = parseCookies(req).bm_session;
  if (!token) return null;
  const row = db.prepare('SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').get(token);
  return row || null;
}
function watchedIds(userId) {
  if (!userId) return new Set();
  return new Set(db.prepare('SELECT product_id FROM watchlist WHERE user_id = ?').all(userId).map((r) => r.product_id));
}
function readBody(req) {
  return new Promise((resolve) => { let d = ''; req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } }); });
}
function json(res, status, obj) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }
function html(res, status, body) { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(body); }

// ---------- OTC lookup ----------
function buildLookup(upcRaw) {
  const upc = String(upcRaw || '').replace(/[\s-]/g, '');
  const found = allOtc.find((p) => p.upc && p.upc === upc);
  if (!found) {
    if (upc) db.prepare('INSERT INTO unknown_upcs (upc) VALUES (?)').run(upc);
    return { found: false, upc, product: null, group: [], differentForm: [], verdict: null };
  }
  const groupObj = identicals.groups.find((g) => g.products.some((p) => p.id === found.id));
  const group = groupObj ? groupObj.products : [found];
  const differentForm = allOtc.filter((p) => p.activeKey === found.activeKey && !group.some((g) => g.id === p.id));
  const priced = group.filter((g) => g.pricePerDose !== null);
  let verdict = null;
  if (!priced.length) verdict = { kind: 'no-prices', cheapestId: null, cheapestName: null, saving: null, savingPerDose: null };
  else {
    const cheapest = priced[0];
    if (found.pricePerDose === null) verdict = { kind: 'scanned-unpriced', cheapestId: cheapest.id, cheapestName: cheapest.name, saving: null, savingPerDose: null };
    else if (cheapest.id === found.id) verdict = { kind: 'already-cheapest', cheapestId: cheapest.id, cheapestName: cheapest.name, saving: 0, savingPerDose: 0 };
    else {
      const perDoseSaving = Math.round((found.pricePerDose - cheapest.pricePerDose) * 10000) / 10000;
      const saving = found.count ? Math.round(perDoseSaving * found.count * 100) / 100 : null;
      verdict = { kind: 'cheaper-available', cheapestId: cheapest.id, cheapestName: cheapest.name, saving, savingPerDose: perDoseSaving };
    }
  }
  return { found: true, upc, product: found, group, differentForm, verdict };
}

// ---------- Layout ----------
function layout(req, title, content) {
  const user = currentUser(req);
  const account = user
    ? `<span class="acct">${esc(user.email)}</span><form method="post" action="/signout" class="inline"><button class="pill-btn" type="submit">Sign out</button></form>`
    : `<a class="pill-btn" href="/watchlist">Sign in / Register</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · BurgerMeter</title><link rel="stylesheet" href="/style.css"></head><body>
<header class="site-header"><a class="brand" href="/"><span class="logo">↗</span><span>BurgerMeter</span></a><nav><a href="/">Catalog</a><a href="/identicals">Identicals</a><a href="/watchlist">Watchlist</a><a href="/methodology">Methodology</a></nav><div class="account">${account}</div></header>
<main>${content}</main>
<footer class="site-footer"><span>BurgerMeter</span><a href="/methodology">How the numbers work</a></footer>
<script src="/app.js"></script></body></html>`;
}
function marginTier(m) { return m < 55 ? ['Low margin', 'tier-low'] : m < 75 ? ['Mid margin', 'tier-mid'] : ['High margin', 'tier-high']; }
function splitBar(p) {
  const total = (p.breakdown || []).reduce((s, b) => s + Number(b[1]), 0) || p.cogs || 1;
  const colors = ['#153D30', '#4C7A63', '#BDE292'];
  const segs = (p.breakdown || []).map((b, i) => `<span style="width:${(Number(b[1]) / total * 100).toFixed(1)}%;background:${colors[i % 3]}"></span>`).join('');
  return `<div class="split-bar" aria-hidden="true">${segs}</div>`;
}
function productCard(p, watched) {
  const m = marginOf(p);
  const [tierLabel, tierClass] = marginTier(m);
  const hist = p.history && p.history.length ? p.history[p.history.length - 1] : null;
  const trend = p.history && p.history.length > 1 ? 'Updated snapshot' : 'First snapshot';
  return `<article class="card">
    <div class="card-top"><span class="eyebrow">${esc(p.category)} · ${esc(p.sub || '')}</span><span class="pill ${tierClass}">${tierLabel}</span></div>
    <h3><a href="/product/${p.id}">${esc(p.name)}</a></h3>
    <p class="detail">${esc(p.detail || '')}</p>
    <div class="nums"><div><span class="lbl">COGS</span><strong>${money(p.cogs)}</strong></div><div><span class="lbl">RETAIL</span><strong>${money(p.retail)}</strong></div></div>
    ${splitBar(p)}
    <div class="meta-row"><span>COGS ${(p.retail ? p.cogs / p.retail * 100 : 0).toFixed(0)}%</span><span>Margin ${m.toFixed(1)}%</span></div>
    <div class="meta-row muted"><span>${hist ? esc(hist.date) : ''}</span><span class="pill tier-mid">${trend}</span></div>
    <button class="pill-btn watch-btn" data-watch="${p.id}">${watched ? 'Watching ✓' : 'Watch'}</button>
  </article>`;
}

// ---------- Pages ----------
function catalogPage(req) {
  const user = currentUser(req);
  const w = watchedIds(user?.id);
  const first = sortProducts(products, 'name').slice(0, 24);
  const content = `
  <section class="hero"><p class="eyebrow light">BURGERMETER</p><h1>What does it cost to make?</h1><p class="tagline">What it costs to make vs what you pay.</p>
  <div class="stats"><div><strong>${products.length.toLocaleString('en-US')}</strong><span>products</span></div><div><strong>${avgMargin.toFixed(1)}%</strong><span>average margin</span></div><div><strong>Every two weeks</strong><span>Prices rechecked every two weeks</span></div></div></section>
  <section class="toolbar"><input id="q" type="search" placeholder="Search products, categories…" aria-label="Search"><select id="cat" aria-label="Category"><option value="">All categories</option>${categories.map((c) => `<option>${esc(c)}</option>`).join('')}</select>
  <select id="sort" aria-label="Sort"><option value="name">Name</option><option value="margin-desc">Margin, high to low</option><option value="margin-asc">Margin, low to high</option><option value="retail-desc">Retail, high to low</option><option value="retail-asc">Retail, low to high</option><option value="cogs-desc">COGS, high to low</option><option value="cogs-asc">COGS, low to high</option></select></section>
  <p id="result-count" class="muted"></p>
  <section id="grid" class="grid">${first.map((p) => productCard(p, w.has(p.id))).join('')}</section>
  <div class="center"><button id="more" class="pill-btn">Load more</button></div>
  <script>window.__BM_PAGE__='catalog';window.__BM_SIGNED_IN__=${user ? 'true' : 'false'};</script>`;
  return layout(req, 'Catalog', content);
}

function productPage(req, id) {
  const p = productsById().get(id);
  if (!p) return null;
  const user = currentUser(req);
  const watched = user ? watchedIds(user.id).has(p.id) : false;
  const m = marginOf(p);
  const { grid, savingsVsHighest } = retailerGrid(p.id);
  const gridRows = grid.map((r) => r.checked
    ? `<tr><td>${esc(r.retailer)}</td><td><strong>${money(r.price)}</strong></td><td>${esc(r.checkedAt)}</td><td>${r.sourceUrl ? `<a href="${esc(r.sourceUrl)}">${esc(r.sourceLabel)}</a>` : esc(r.sourceLabel)}</td></tr>`
    : `<tr><td>${esc(r.retailer)}</td><td colspan="3" class="muted">Not checked yet</td></tr>`).join('');
  // history chart
  const hist = p.history && p.history.length ? p.history : [{ date: '2026-11-02', retail: p.retail, cogs: p.cogs }];
  const maxV = Math.max(...hist.map((h) => h.retail), ...hist.map((h) => h.cogs)) * 1.1 || 1;
  const pts = (key) => hist.map((h, i) => `${hist.length === 1 ? 60 : 10 + i * (280 / (hist.length - 1))},${90 - (h[key] / maxV) * 80}`).join(' ');
  const chart = hist.length > 1
    ? `<svg viewBox="0 0 300 100" class="chart" role="img" aria-label="Price history chart"><polyline fill="none" stroke="#205740" stroke-width="2" points="${pts('retail')}"/><polyline fill="none" stroke="#B36D48" stroke-width="2" points="${pts('cogs')}"/></svg><p class="muted">Retail line #205740 · COGS line #B36D48</p>`
    : `<svg viewBox="0 0 300 100" class="chart" role="img" aria-label="Price history, single snapshot"><circle cx="60" cy="${90 - (hist[0].retail / maxV) * 80}" r="4" fill="#205740"/><circle cx="60" cy="${90 - (hist[0].cogs / maxV) * 80}" r="4" fill="#B36D48"/></svg><p class="muted">First snapshot on ${esc(hist[0].date)}. Trend appears when a second snapshot is recorded.</p>`;
  const breakdownRows = (p.breakdown || []).map((b) => `<div class="leader"><span>${esc(b[0])}</span><span class="dots"></span><span>${money(b[1])}</span></div>`).join('');
  const content = `<p><a href="/">← Back to catalog</a></p>
  <p class="eyebrow">${esc(p.category)} • ${esc(p.detail || '')}</p><h1>${esc(p.name)}</h1>
  <div class="detail-nums"><div><span class="lbl">ESTIMATED COGS</span><strong>${money(p.cogs)}</strong></div><div><span class="lbl">RETAIL</span><strong>${money(p.retail)}</strong></div><div><span class="lbl">MARGIN</span><strong class="huge">${m.toFixed(1)}%</strong></div></div>
  <p>Retail is ${(p.cogs ? (p.retail / p.cogs + 1e-9) : 0).toFixed(2)}x the estimated cost to make one unit.</p>
  <h2>Cost breakdown</h2>${splitBar(p)}${breakdownRows}<div class="leader total"><span>Total COGS</span><span class="dots"></span><span>${money(p.cogs)}</span></div><div class="leader total"><span>Retail</span><span class="dots"></span><span>${money(p.retail)}</span></div>
  <h2>Retailer prices</h2>${savingsVsHighest !== null ? `<p class="saving">You save ${money(savingsVsHighest)} vs the highest</p>` : ''}<div class="table-wrap"><table><thead><tr><th>Retailer</th><th>Price</th><th>Checked</th><th>Source</th></tr></thead><tbody>${gridRows}</tbody></table></div>
  <h2>Price history</h2>${chart}
  <p><button class="pill-btn watch-btn" data-watch="${p.id}">${watched ? 'Watching ✓' : 'Watch'}</button> <span class="muted">Track this product for price change alerts.</span></p>
  <script>window.__BM_SIGNED_IN__=${user ? 'true' : 'false'};</script>`;
  return layout(req, p.name, content);
}

function fmtPerDose(v) { return v === null || v === undefined ? '—' : `${(v * 100).toFixed(1).replace(/\.0$/, '.0')}¢`; }
function identicalsPage(req) {
  const cheapestByGroup = new Map();
  for (const g of identicals.groups) { const priced = g.products.filter((p) => p.pricePerDose !== null); if (priced.length) cheapestByGroup.set(g.key, priced[0].id); }
  const tables = identicals.groups.map((g) => {
    const multi = g.activesLabel.includes('+');
    const subline = multi
      ? 'All of these have the same active ingredients at the same strength. Buy the cheapest per dose.'
      : 'All of these have the same active ingredient at the same strength. Buy the cheapest per dose.';
    const rows = g.products.map((p) => {
      const isCheapest = cheapestByGroup.get(g.key) === p.id && p.pricePerDose !== null;
      const liquidGel = /liquid filled/i.test(p.dosageForm) ? ' <span class="pill tier-mid">liquid gel, faster absorption</span>' : '';
      const priceCell = p.price !== null ? `<strong>${money(p.price)}</strong><br><span class="muted">${esc(p.priceCheckedAt || '')} · ${esc(p.priceSourceLabel || '')}</span>` : '<span class="muted">Price not checked yet</span>';
      return `<tr data-search="${esc((p.name + ' ' + (p.labeler || '') + ' ' + g.activesLabel).toLowerCase())}"><td data-label="Product"><strong>${esc(p.name)}</strong>${isCheapest ? ' <span class="pill cheapest">Cheapest</span>' : ''}<br><span class="muted">${esc(p.labeler || '')}</span><br><a href="${esc(p.sourceUrl || '#')}">DailyMed source</a></td><td data-label="Form">${esc(p.dosageForm)}${liquidGel}</td><td data-label="Count">${esc(p.sizeLabel)}</td><td data-label="Price">${priceCell}</td><td data-label="Price per dose">${p.pricePerDose !== null ? fmtPerDose(p.pricePerDose) + '/dose' : '—'}</td></tr>`;
    }).join('');
    return `<section class="otc-group" data-cats="${esc(g.categories.join(','))}"><h2>${esc(g.activesLabel)}</h2><p class="muted">${subline}</p>${g.releaseNote ? `<p class="pill tier-mid">${esc(g.releaseNote)}</p>` : ''}<div class="table-wrap"><table class="otc-table"><thead><tr><th>Product</th><th>Form</th><th>Count</th><th>Price</th><th>Price per dose</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }).join('');
  const content = `<h1>Identicals</h1><p>Products with the same active ingredients and strength, side by side. Inactive ingredients can differ, and this is price information, not medical advice.</p>
  <section class="card tool"><h2>Check a product</h2>
  <label>UPC <input id="upc-input" inputmode="numeric" placeholder="Enter UPC, for example 305730160407"></label>
  <button id="upc-btn" class="pill-btn" type="button">Look up UPC</button>
  <button id="scan-btn" class="pill-btn" type="button">Scan with camera</button>
  <label>Search by name <input id="otc-q" type="search" placeholder="Search OTC products…"></label>
  <video id="scan-video" hidden style="max-width:100%"></video>
  <div id="lookup-result" aria-live="polite"></div><div id="otc-results"></div></section>
  <div class="chips" id="cat-chips"><button class="chip active" data-cat="All">All</button><button class="chip" data-cat="Pain relief">Pain relief</button><button class="chip" data-cat="Allergy">Allergy</button><button class="chip" data-cat="Cold and flu">Cold and flu</button><button class="chip" data-cat="Sleep">Sleep</button></div>
  <label>Filter tables <input id="table-q" type="search" placeholder="Filter or highlight rows…"></label>
  ${tables}
  <p class="muted">Wording rule. We always say same active ingredients and strength. Inactive ingredients can differ. This is price information, not medical advice. Source for active ingredients, strength, form and labeler is DailyMed.</p>
  <script src="${ZXING_URL}"></script><script>window.__BM_PAGE__='identicals';</script>`;
  return layout(req, 'Identicals', content);
}

function watchlistPage(req) {
  const user = currentUser(req);
  if (!user) {
    const content = `<h1>Watchlist</h1><p>Sign in to watch products and get in-app alerts when COGS or retail changes.</p>
    <div class="auth-grid">
    <section class="card"><h2>Sign in</h2><form id="signin-form"><label>Email <input name="email" type="email" required></label><label>Password <input name="password" type="password" required></label><button class="pill-btn" type="submit">Sign in</button></form></section>
    <section class="card"><h2>Register</h2><form id="register-form"><label>Email <input name="email" type="email" required></label><label>Password <input name="password" type="password" minlength="8" required></label><button class="pill-btn" type="submit">Register</button></form></section>
    </div><p id="auth-msg" class="muted"></p><script>window.__BM_PAGE__='auth';</script>`;
    return layout(req, 'Watchlist', content);
  }
  const byId = productsById();
  const rows = db.prepare('SELECT product_id FROM watchlist WHERE user_id = ? ORDER BY rowid DESC').all(user.id);
  const items = rows.map((r) => byId.get(r.product_id)).filter(Boolean).map((p) => `<article class="card"><h3><a href="/product/${p.id}">${esc(p.name)}</a></h3><p class="muted">${esc(p.detail || '')}</p><p>COGS ${money(p.cogs)} · RETAIL ${money(p.retail)} · Margin ${marginOf(p).toFixed(1)}%</p><button class="pill-btn watch-btn" data-watch="${p.id}">Remove</button></article>`).join('');
  const notifs = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(user.id);
  const notifHtml = notifs.length ? notifs.map((n) => { const p = byId.get(n.product_id); return `<li><strong>${esc(p ? p.name : 'Product ' + n.product_id)}</strong> ${esc(n.field)} changed from ${money(n.old_value)} to ${money(n.new_value)} <span class="muted">${esc(n.created_at)}</span></li>`; }).join('') : '<li class="muted">No alerts yet.</li>';
  const content = `<h1>Watchlist</h1><p>Signed in as ${esc(user.email)}</p><section class="grid">${items || '<p class="muted">Nothing watched yet. Add products from the catalog.</p>'}</section><h2>Alerts</h2><ul class="alerts">${notifHtml}</ul><script>window.__BM_PAGE__='watchlist';window.__BM_SIGNED_IN__=true;</script>`;
  return layout(req, 'Watchlist', content);
}

function methodologyPage(req) {
  const content = `<p class="eyebrow">ABOUT BURGERMETER</p><h1>How the numbers work</h1>
  <h2>What goes into COGS</h2><p>COGS is the theorized cost to make one unit. It has three buckets. Ingredients or parts. Packaging. Labor. Those three buckets are shown for every product, and they add up to the total COGS figure.</p>
  <h2>How we calculate margin</h2><p>Margin is (retail − COGS) ÷ retail × 100. It is the share of the retail price that is above the estimated cost to make the product.</p>
  <h2>Theorized estimates, not a profit statement</h2><p>These are theorized estimates built from raw-material costs at manufacturer buying volume. They are not a manufacturer profit statement, and they do not include every cost a company carries.</p>
  <h2>When prices update</h2><p>Prices are rechecked every two weeks. The trend compares the latest snapshot to the previous snapshot for the same unit size. A product with one snapshot is labelled First snapshot.</p>
  <h2>What we do not include</h2><p>COGS does not include shipping, warehousing, retail store costs, marketing, taxes, or retailer margin. The retailer grid does not store retailer cost or retailer margin.</p>
  <h2>Retailer price grid</h2><p>The grid shows observed prices only. Every priced row is dated and sourced. A retailer with no observation shows Not checked yet. When two or more priced rows exist, we show the saving versus the highest price.</p>
  <h2>Identicals</h2><p>Identicals groups products with the same active ingredients and strength. Active ingredients, strength, dosage form and labeler come from DailyMed. Prices are observed, dated and sourced. Inactive ingredients can differ. This is price information, not medical advice.</p>`;
  return layout(req, 'How the numbers work', content);
}

// ---------- Server ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    if (pathname === '/style.css') { res.writeHead(200, { 'Content-Type': 'text/css' }); return res.end(fs.readFileSync(path.join(__dirname, 'public', 'style.css'))); }
    if (pathname === '/app.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(fs.readFileSync(path.join(__dirname, 'public', 'app.js'))); }
    if (pathname === '/healthz') return json(res, 200, { ok: true, products: products.length, otcProducts: allOtc.length });
    // APIs
    if (pathname === '/api/products') {
      const query = url.searchParams.get('query') || url.searchParams.get('q') || '';
      const category = url.searchParams.get('category') || '';
      const sort = url.searchParams.get('sort') || 'name';
      const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
      const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('pageSize') || '24', 10) || 24));
      let list = products.filter((p) => (!category || p.category === category) && matchesQuery(p, query));
      list = sortProducts(list, sort);
      const total = list.length;
      const user = currentUser(req); const w = watchedIds(user?.id);
      const slice = list.slice((page - 1) * pageSize, page * pageSize).map((p) => ({ id: p.id, name: p.name, detail: p.detail, category: p.category, sub: p.sub, cogs: p.cogs, retail: p.retail, breakdown: p.breakdown, history: p.history, margin: Math.round(marginOf(p) * 10) / 10, watched: w.has(p.id) }));
      return json(res, 200, { total, page, pageSize, products: slice });
    }
    if (pathname.startsWith('/api/product/')) {
      const id = parseInt(pathname.split('/')[3], 10); const p = productsById().get(id); if (!p) return json(res, 404, { error: 'not found' });
      const { grid, savingsVsHighest } = retailerGrid(id);
      return json(res, 200, { ...p, margin: marginOf(p), retailerPrices: grid, savingsVsHighest });
    }
    if (pathname === '/api/lookup') return json(res, 200, buildLookup(url.searchParams.get('upc') || ''));
    if (pathname === '/api/otc-search') {
      const q = (url.searchParams.get('q') || url.searchParams.get('query') || '').toLowerCase();
      const found = q ? allOtc.filter((p) => `${p.name} ${p.labeler || ''} ${p.activesLabel}`.toLowerCase().includes(q)) : [];
      return json(res, 200, { products: found.slice(0, 30) });
    }
    if (pathname === '/api/me') { const u = currentUser(req); return json(res, 200, { user: u ? { id: u.id, email: u.email } : null }); }
    if (pathname === '/api/register' && req.method === 'POST') {
      const { email, password } = await readBody(req);
      if (!email || !password || String(password).length < 8) return json(res, 400, { error: 'Email and a password of at least 8 characters are required.' });
      const { salt, hash } = hashPassword(String(password));
      try { const info = db.prepare('INSERT INTO users (email, password_hash, salt) VALUES (?, ?, ?)').run(String(email).toLowerCase(), hash, salt); const token = crypto.randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, Number(info.lastInsertRowid)); res.writeHead(201, { 'Content-Type': 'application/json', 'Set-Cookie': `bm_session=${token}; HttpOnly; Path=/; SameSite=Lax` }); return res.end(JSON.stringify({ user: { id: Number(info.lastInsertRowid), email: String(email).toLowerCase() } })); }
      catch { return json(res, 409, { error: 'That email is already registered.' }); }
    }
    if (pathname === '/api/signin' && req.method === 'POST') {
      const { email, password } = await readBody(req);
      const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase());
      if (!user || !verifyPassword(String(password || ''), user.salt, user.password_hash)) return json(res, 401, { error: 'Email or password did not match an account.' });
      const token = crypto.randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, user.id);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `bm_session=${token}; HttpOnly; Path=/; SameSite=Lax` }); return res.end(JSON.stringify({ user: { id: user.id, email: user.email } }));
    }
    if (pathname === '/api/signout' && req.method === 'POST') {
      const token = parseCookies(req).bm_session; if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'bm_session=; HttpOnly; Path=/; Max-Age=0' }); return res.end(JSON.stringify({ ok: true }));
    }
    if (pathname === '/signout' && req.method === 'POST') {
      const token = parseCookies(req).bm_session; if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      res.writeHead(302, { Location: '/', 'Set-Cookie': 'bm_session=; HttpOnly; Path=/; Max-Age=0' }); return res.end();
    }
    if (pathname === '/api/watch' && req.method === 'POST') {
      const user = currentUser(req); if (!user) return json(res, 401, { error: 'Sign in required.' });
      const { productId } = await readBody(req); const pid = Number(productId);
      if (!productsById().has(pid)) return json(res, 404, { error: 'Product not found.' });
      const existing = db.prepare('SELECT user_id FROM watchlist WHERE user_id = ? AND product_id = ?').get(user.id, pid);
      if (existing) { db.prepare('DELETE FROM watchlist WHERE user_id = ? AND product_id = ?').run(user.id, pid); return json(res, 200, { watched: false }); }
      db.prepare('INSERT INTO watchlist (user_id, product_id) VALUES (?, ?)').run(user.id, pid); return json(res, 200, { watched: true });
    }
    if (pathname === '/api/watchlist') {
      const user = currentUser(req); if (!user) return json(res, 401, { error: 'Sign in required.' });
      const byId = productsById(); const rows = db.prepare('SELECT product_id FROM watchlist WHERE user_id = ? ORDER BY rowid DESC').all(user.id);
      return json(res, 200, { products: rows.map((r) => byId.get(r.product_id)).filter(Boolean) });
    }
    if (pathname === '/api/notifications') {
      const user = currentUser(req); if (!user) return json(res, 401, { error: 'Sign in required.' });
      const rows = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(user.id);
      const byId = productsById();
      return json(res, 200, { notifications: rows.map((n) => ({ ...n, productName: byId.get(n.product_id)?.name || null })) });
    }
    // Pages
    if (pathname === '/') return html(res, 200, catalogPage(req));
    const prodMatch = pathname.match(/^\/product\/(\d+)$/);
    if (prodMatch) { const pageHtml = productPage(req, parseInt(prodMatch[1], 10)); if (!pageHtml) { res.writeHead(404); return res.end('Not found'); } return html(res, 200, pageHtml); }
    if (pathname === '/identicals') return html(res, 200, identicalsPage(req));
    if (pathname === '/watchlist') return html(res, 200, watchlistPage(req));
    if (pathname === '/methodology') return html(res, 200, methodologyPage(req));
    res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found');
  } catch (err) {
    console.error(err); res.writeHead(500, { 'Content-Type': 'text/plain' }); return res.end('Server error');
  }
});

if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, HOST, () => console.log(`BurgerMeter listening on ${HOST}:${PORT} products=${products.length} otc=${allOtc.length} avgMargin=${avgMargin.toFixed(1)} startupCheck=${JSON.stringify(startupCheck)}`));
}
export { server };
