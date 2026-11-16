// Blog post. One file per post in this directory.
// Required fields: slug, title, date (YYYY-MM-DD), excerpt, body (HTML string).
// The server loads every .mjs file here at startup and lists posts newest first.
export default {
  slug: 'two-prices',
  title: 'Every product has two prices',
  date: '2026-11-15',
  excerpt: 'What it costs to make one unit, and what you pay for it. Three products from the catalog, two numbers each.',
  body: `
  <p>BurgerMeter tracks two numbers for every product in the catalog. The estimated cost to make one unit. The price you pay at the register. This post puts three of them side by side.</p>
  <h2>91.2% margin</h2>
  <p><strong><a href="/product/558">Colgate Manual Toothbrush, Soft</a></strong> · 1 toothbrush</p>
  <div class="nums"><div><span class="lbl">ESTIMATED COGS</span><strong>$0.35</strong></div><div><span class="lbl">RETAIL</span><strong>$3.99</strong></div></div>
  <p>The brush costs an estimated 35 cents to make. It sells for $3.99.</p>
  <h2>79.8% margin</h2>
  <p><strong><a href="/product/205">Coca-Cola Classic</a></strong> · 12 fl oz · 1 can</p>
  <div class="nums"><div><span class="lbl">ESTIMATED COGS</span><strong>$0.22</strong></div><div><span class="lbl">RETAIL</span><strong>$1.09</strong></div></div>
  <p>One can costs an estimated 22 cents to make. It sells for $1.09.</p>
  <h2>72.9% margin</h2>
  <p><strong><a href="/product/157">Kellogg's Corn Flakes Cereal</a></strong> · 9 oz box</p>
  <div class="nums"><div><span class="lbl">ESTIMATED COGS</span><strong>$0.67</strong></div><div><span class="lbl">RETAIL</span><strong>$2.47</strong></div></div>
  <p>A 9 oz box costs an estimated 67 cents to make. It sells for $2.47.</p>
  <h2>How to read these numbers</h2>
  <p>COGS is a theorized estimate. It counts ingredients or parts, packaging, and labor, built from raw material costs at manufacturer buying volume. It is not a manufacturer profit statement.</p>
  <p>Every product in the <a href="/">catalog</a> carries the same two numbers. The full method is on the <a href="/methodology">methodology page</a>.</p>`,
};
