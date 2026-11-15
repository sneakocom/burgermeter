async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
function money(n) { return '$' + Number(n).toFixed(2); }

// Watch buttons (delegated)
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-watch]');
  if (!btn) return;
  if (window.__BM_SIGNED_IN__ === false) { alert('Sign in to watch this product.'); location.href = '/watchlist'; return; }
  const id = Number(btn.dataset.watch);
  const { body } = await api('/api/watch', { method: 'POST', body: JSON.stringify({ productId: id }) });
  if (typeof body.watched === 'boolean') {
    if (window.__BM_PAGE__ === 'watchlist' && !body.watched) location.reload();
    else btn.textContent = body.watched ? 'Watching ✓' : 'Watch';
  }
});

// Catalog
if (window.__BM_PAGE__ === 'catalog') {
  let page = 1; const pageSize = 24;
  const grid = document.getElementById('grid'), more = document.getElementById('more'), count = document.getElementById('result-count');
  function card(p) {
    const m = p.margin; const tier = m < 55 ? ['Low margin', 'tier-low'] : m < 75 ? ['Mid margin', 'tier-mid'] : ['High margin', 'tier-high'];
    const total = (p.breakdown || []).reduce((s, b) => s + b[1], 0) || p.cogs; const colors = ['#153D30', '#4C7A63', '#BDE292'];
    const segs = (p.breakdown || []).map((b, i) => `<span style="width:${(b[1] / total * 100).toFixed(1)}%;background:${colors[i % 3]}"></span>`).join('');
    const hist = p.history && p.history.length ? p.history[p.history.length - 1] : null;
    return `<article class="card"><div class="card-top"><span class="eyebrow">${p.category} · ${p.sub || ''}</span><span class="pill ${tier[1]}">${tier[0]}</span></div><h3><a href="/product/${p.id}">${p.name}</a></h3><p class="detail">${p.detail || ''}</p><div class="nums"><div><span class="lbl">COGS</span><strong>${money(p.cogs)}</strong></div><div><span class="lbl">RETAIL</span><strong>${money(p.retail)}</strong></div></div><div class="split-bar">${segs}</div><div class="meta-row"><span>COGS ${Math.round(p.cogs / p.retail * 100)}%</span><span>Margin ${m.toFixed(1)}%</span></div><div class="meta-row muted"><span>${hist ? hist.date : ''}</span><span class="pill tier-mid">${p.history && p.history.length > 1 ? 'Updated snapshot' : 'First snapshot'}</span></div><button class="pill-btn watch-btn" data-watch="${p.id}">${p.watched ? 'Watching ✓' : 'Watch'}</button></article>`;
  }
  async function load(reset) {
    if (reset) page = 1;
    const q = document.getElementById('q').value, cat = document.getElementById('cat').value, sort = document.getElementById('sort').value;
    const { body } = await api(`/api/products?query=${encodeURIComponent(q)}&category=${encodeURIComponent(cat)}&sort=${encodeURIComponent(sort)}&page=${page}&pageSize=${pageSize}`);
    count.textContent = body.total + ' products';
    const html = (body.products || []).map(card).join('');
    if (reset) grid.innerHTML = html; else grid.insertAdjacentHTML('beforeend', html);
    more.style.display = page * pageSize >= body.total ? 'none' : '';
  }
  // Server rendered the first page already; wire controls.
  count.textContent = '';
  let t; document.getElementById('q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => load(true), 250); });
  document.getElementById('cat').addEventListener('change', () => load(true));
  document.getElementById('sort').addEventListener('change', () => load(true));
  more.addEventListener('click', () => { page++; load(false); });
}

// Auth forms
if (window.__BM_PAGE__ === 'auth') {
  async function submit(id, path) {
    const form = document.getElementById(id); if (!form) return;
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); const fd = new FormData(form);
      const { status, body } = await api(path, { method: 'POST', body: JSON.stringify({ email: fd.get('email'), password: fd.get('password') }) });
      if (status < 300) location.reload(); else document.getElementById('auth-msg').textContent = body.error || 'Something went wrong.';
    });
  }
  submit('signin-form', '/api/signin'); submit('register-form', '/api/register');
}

// Identicals
if (window.__BM_PAGE__ === 'identicals') {
  const result = document.getElementById('lookup-result');
  function renderLookup(body) {
    if (!body.found) { result.innerHTML = '<p class="pill tier-high">Not in the database yet</p><p class="muted">We recorded that UPC so it can be researched.</p>'; return; }
    const p = body.product; let verdict = '';
    if (body.verdict && body.verdict.kind === 'cheaper-available') verdict = `<p class="pill cheapest">Same active ingredients for less</p><p>The cheapest in this group is <strong>${body.verdict.cheapestName}</strong>${body.verdict.saving !== null ? `, saving ${money(body.verdict.saving)} at the same count.` : '.'}</p>`;
    else if (body.verdict && body.verdict.kind === 'already-cheapest') verdict = '<p class="pill cheapest">Already the cheapest per dose in its group</p>';
    else if (body.verdict && body.verdict.kind === 'scanned-unpriced') verdict = `<p>Priced options exist in this group. The cheapest is <strong>${body.verdict.cheapestName}</strong>.</p>`;
    else verdict = '<p class="muted">No verified prices in this group yet.</p>';
    result.innerHTML = `${verdict}<p><strong>${p.name}</strong> · ${p.labeler || ''} · ${p.activesLabel} · ${p.sizeLabel}${p.price !== null ? ' · ' + money(p.price) : ''}</p>`;
  }
  async function lookup(upc) { const { body } = await api('/api/lookup?upc=' + encodeURIComponent(upc)); renderLookup(body); }
  document.getElementById('upc-btn').addEventListener('click', () => { const v = document.getElementById('upc-input').value.trim(); if (v) lookup(v); });
  document.getElementById('otc-q').addEventListener('input', async (e) => {
    const q = e.target.value.trim(); const box = document.getElementById('otc-results');
    if (!q) { box.innerHTML = ''; return; }
    const { body } = await api('/api/otc-search?q=' + encodeURIComponent(q));
    box.innerHTML = (body.products || []).map((p) => `<p><button class="pill-btn" data-upc-lookup="${p.upc || ''}" ${p.upc ? '' : 'disabled'}>${p.name}</button> <span class="muted">${p.activesLabel} · ${p.sizeLabel}</span></p>`).join('') || '<p class="muted">No matches.</p>';
    box.querySelectorAll('[data-upc-lookup]').forEach((b) => b.addEventListener('click', () => lookup(b.dataset.upcLookup)));
  });
  document.getElementById('scan-btn').addEventListener('click', async () => {
    const video = document.getElementById('scan-video');
    if (!window.ZXingBrowser || !navigator.mediaDevices) { result.innerHTML = '<p class="muted">Camera scanning is not available here. Manual UPC entry always works.</p>'; return; }
    try {
      video.hidden = false;
      const reader = new ZXingBrowser.BrowserMultiFormatReader();
      const controls = await reader.decodeFromVideoDevice(undefined, video, (res) => { if (res) { const text = res.getText(); document.getElementById('upc-input').value = text; lookup(text); controls.stop(); video.hidden = true; } });
    } catch { result.innerHTML = '<p class="muted">Camera scanning failed. Manual UPC entry always works.</p>'; }
  });
  document.querySelectorAll('#cat-chips .chip').forEach((chip) => chip.addEventListener('click', () => {
    document.querySelectorAll('#cat-chips .chip').forEach((c) => c.classList.remove('active')); chip.classList.add('active');
    const cat = chip.dataset.cat;
    document.querySelectorAll('.otc-group').forEach((g) => { g.style.display = (cat === 'All' || g.dataset.cats.split(',').includes(cat)) ? '' : 'none'; });
  }));
  document.getElementById('table-q').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll('.otc-group tbody tr').forEach((tr) => {
      const hit = !q || tr.dataset.search.includes(q); tr.style.display = hit ? '' : 'none';
      tr.querySelectorAll('mark').forEach((mk) => mk.replaceWith(document.createTextNode(mk.textContent)));
    });
  });
}
