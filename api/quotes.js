// Vercel serverless function: وسيط بيانات للأسهم المصرية.
// المصدر: Yahoo Finance (رموز البورصة المصرية بلاحقة .CA)، وهو غير رسمي وغالبًا متأخر عن السوق.

const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const UA = 'Mozilla/5.0 (compatible; egx-radar/1.0)';
const TTL_QUOTE = 3000;
const TTL_HIST = 10 * 60 * 1000;
const MAX_SYMBOLS = 80;
const CONCURRENCY = 8;

const cache = new Map();

async function yahoo(symbol, range, interval) {
  const url = `${YAHOO}${encodeURIComponent(symbol)}.CA?range=${range}&interval=${interval}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${symbol} ${r.status}`);
  const j = await r.json();
  const res = j && j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error(`${symbol} no data`);
  return res;
}

async function getHist(sym) {
  const key = 'h:' + sym, hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_HIST) return hit.data;
  const res = await yahoo(sym, '6mo', '1d');
  const ts = res.timestamp || [], qt = (res.indicators.quote || [{}])[0];
  const off = res.meta.gmtoffset || 0;
  const day = t => Math.floor((t + off) / 86400);
  const out = { c: [], h: [], l: [], v: [] };
  for (let i = 0; i < ts.length; i++) {
    if (qt.close[i] == null || qt.high[i] == null || qt.low[i] == null) continue;
    out.c.push(qt.close[i]); out.h.push(qt.high[i]); out.l.push(qt.low[i]); out.v.push(qt.volume[i] || 0);
  }
  if (ts.length && res.meta.regularMarketTime && day(ts[ts.length - 1]) === day(res.meta.regularMarketTime)) {
    ['c', 'h', 'l', 'v'].forEach(k => out[k].pop());
  }
  cache.set(key, { at: Date.now(), data: out });
  return out;
}

async function getQuote(sym) {
  const key = 'q:' + sym, hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_QUOTE) return hit.data;
  const res = await yahoo(sym, '1d', '1m');
  const m = res.meta;
  const q = { t: sym, p: m.regularMarketPrice, pc: m.chartPreviousClose || m.previousClose, v: m.regularMarketVolume || 0 };
  cache.set(key, { at: Date.now(), data: q });
  return q;
}

async function pool(items, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < items.length) {
      const my = items[i++];
      try { out.push(await fn(my)); } catch (e) { /* skip failed symbol */ }
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
