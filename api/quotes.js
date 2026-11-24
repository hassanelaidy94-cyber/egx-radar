// Vercel serverless function: وسيط بيانات للأسهم المصرية.
// المصدر: ماسح TradingView للبورصة المصرية (غير رسمي، وبياناته غالبًا متأخرة عن السوق).
// الطلب:  /api/quotes?s=COMI,TALM
// الرد:   { q: [ { t, p, chg, v, av, rsi, e9, e21, mh, atr } ], ts, delayed, mode }
//   p=آخر سعر، chg=نسبة التغير %، v=حجم اليوم، av=متوسط حجم 10 أيام،
//   rsi=RSI(14)، e9/e21=متوسطات متحركة أسية، mh=هيستوجرام MACD، atr=ATR(14)

const SCAN = 'https://scanner.tradingview.com/egypt/scan';
const UA = 'Mozilla/5.0 (compatible; egx-radar/2.0)';
const COLS = ['close', 'change', 'volume', 'average_volume_10d_calc', 'RSI', 'EMA10', 'EMA20',
  'MACD.macd', 'MACD.signal', 'ATR', 'update_mode'];
const EXT = ['High.1W', 'Low.1W', 'High.1M', 'Low.1M'];
const WK = ['RSI|1W', 'EMA10|1W', 'EMA20|1W', 'MACD.macd|1W', 'MACD.signal|1W'];
let level = 2;   // 2: الكل، 1: بدون الأسبوعي، 0: الأساسي فقط
const TTL = 3000;
const MAX_SYMBOLS = 400;
let allCache = { at: 0, body: null };

let cache = { key: '', at: 0, body: null };

const num = x => (typeof x === 'number' && Number.isFinite(x)) ? x : null;
const r4 = x => x === null ? null : Math.round(x * 10000) / 10000;

function parse(rows) {
  const q = []; let streaming = 0;
  for (const row of rows || []) {
    const d = row.d || [];
    const t = String(row.s || '').split(':')[1];
    const p = num(d[0]);
    if (!t || !(p > 0)) continue;
    const macd = num(d[7]), sig = num(d[8]);
    if (d[10] === 'streaming') streaming++;
    q.push({
      t, p: r4(p), chg: r4(num(d[1])), v: num(d[2]) || 0, av: num(d[3]) || 0,
      rsi: r4(num(d[4])), e9: r4(num(d[5])), e21: r4(num(d[6])),
      mh: macd !== null && sig !== null ? r4(macd - sig) : null, atr: r4(num(d[9])),
      hw: r4(num(d[11])), lw: r4(num(d[12])), hm: r4(num(d[13])), lm: r4(num(d[14])),
      wr: r4(num(d[15])), we9: r4(num(d[16])), we21: r4(num(d[17])),
      wmh: num(d[18]) !== null && num(d[19]) !== null ? r4(num(d[18]) - num(d[19])) : null,
    });
  }
  return { q, delayed: !(q.length && streaming === q.length) };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=2, stale-while-revalidate=5');
  const url = new URL(req.url, 'http://x');
  // بحث عن الرمز الصحيح عند TradingView:  /api/quotes?find=EGX30
  const find = (url.searchParams.get('find') || '').trim();
  if (find) {
    if (!/^[A-Za-z0-9 .\-]{2,30}$/.test(find)) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'bad find' })); }
    try {
      const r = await fetch(SCAN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA, Origin: 'https://www.tradingview.com' },
        body: JSON.stringify({
          filter: [{ left: 'name', operation: 'match', right: find }],
          columns: ['name', 'description', 'close', 'type'], range: [0, 20],
        }),
      });
      if (!r.ok) throw new Error('scanner ' + r.status);
      const j = await r.json();
      return res.end(JSON.stringify({ found: (j.data || []).map(x => ({ s: x.s, d: x.d })) }));
    } catch (e) {
      res.statusCode = 502; return res.end(JSON.stringify({ error: String(e.message || e) }));
    }
  }
  // كل أسهم البورصة المصرية:  /api/quotes?all=1
  if (url.searchParams.get('all')) {
    if (allCache.body && Date.now() - allCache.at < 3600000) return res.end(allCache.body);
    try {
      const r = await fetch(SCAN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA, Origin: 'https://www.tradingview.com' },
        body: JSON.stringify({
          columns: ['name', 'description', 'close', 'type'], range: [0, 700],
          sort: { sortBy: 'volume', sortOrder: 'desc' },
        }),
      });
      if (!r.ok) throw new Error('scanner ' + r.status);
      const j = await r.json();
      const all = [];
      for (const x of j.data || []) {
        const d = x.d || [];
        const t = String(x.s || '').split(':')[1];
        if (String(x.s || '').split(':')[0] !== 'EGX' || d[3] !== 'stock') continue;
        if (!t || !/^[A-Z0-9]{2,12}$/.test(t) || !(num(d[2]) > 0)) continue;
        all.push({ t, n: String(d[1] || t), p: r4(num(d[2])) });
      }
      if (!all.length) throw new Error('empty list');
      const body = JSON.stringify({ all });
      allCache = { at: Date.now(), body };
      return res.end(body);
    } catch (e) {
      res.statusCode = 502; return res.end(JSON.stringify({ error: String(e.message || e) }));
    }
  }
  const syms = (url.searchParams.get('s') || '')
    .split(',').map(s => s.trim().toUpperCase()).filter(s => /^[A-Z0-9]{2,12}$/.test(s)).slice(0, MAX_SYMBOLS);
  if (!syms.length) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'missing s' })); }
  const key = syms.join(',');
  if (cache.key === key && Date.now() - cache.at < TTL) return res.end(cache.body);
  try {
    const scan = cols => fetch(SCAN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA, Origin: 'https://www.tradingview.com' },
      body: JSON.stringify({ symbols: { tickers: syms.map(s => 'EGX:' + s) }, columns: cols }),
    });
    const sets = [COLS, COLS.concat(EXT), COLS.concat(EXT, WK)];
    let r = await scan(sets[level]);
    while (!r.ok && level > 0) { level--; r = await scan(sets[level]); }   // لو أعمدة مش مدعومة نرجع خطوة
    if (!r.ok) throw new Error('scanner ' + r.status);
    const j = await r.json();
    const { q, delayed } = parse(j.data);
    if (!q.length) { res.statusCode = 502; return res.end(JSON.stringify({ error: 'no quotes' })); }
    const body = JSON.stringify({ q, ts: Date.now(), delayed });
    cache = { key, at: Date.now(), body };
    res.end(body);
  } catch (e) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
};
