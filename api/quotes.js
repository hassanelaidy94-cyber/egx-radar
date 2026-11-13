}

// تشغيل المهام بحد أقصى للتوازي
async function pool(items, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < items.length) {
      const my = items[i++];
      try { out.push(await fn(my)); } catch (e) { /* تخطَّ الرمز الفاشل */ }
    }
  }));
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=2, stale-while-revalidate=5');
  const url = new URL(req.url, 'http://x');
  const syms = (url.searchParams.get('s') || '')
    .split(',').map(s => s.trim().toUpperCase()).filter(s => /^[A-Z0-9]{2,12}$/.test(s)).slice(0, MAX_SYMBOLS);
  if (!syms.length) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'missing s' })); }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    if (url.searchParams.get('mode') === 'hist') {
      const rows = await pool(syms, async s => [s, await getHist(s)]);
      return res.end(JSON.stringify({ h: Object.fromEntries(rows) }));
    }
    const q = await pool(syms, getQuote);
    if (!q.length) { res.statusCode = 502; return res.end(JSON.stringify({ error: 'no quotes' })); }
    res.end(JSON.stringify({ q, ts: Date.now(), delayed: true }));
  } catch (e) {
    res.statusCode = 502; res.end(JSON.stringify({ error: String(e.message || e) }));
  }
};
