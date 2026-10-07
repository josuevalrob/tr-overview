/**
 * Directors' dealings of German issuers from BaFin's public database: what board members and people
 * close to them bought and sold (EU market abuse rules, art. 19) - CSV, no key. In the shape of
 * Nasdaq's insider trades, so the read-out treats both alike.
 *
 *   dealings(isin, today) -> { m3, m12: { buys, sells, bought, sold }, recent: [{ name, relation, date,
 *                              type, shares, price }], source: 'BaFin' } or null
 *
 * Only purchases ("Kauf") and sales ("Verkauf") count; grants and other transfers ("Sonstiges") do not.
 * Shares = the reported volume (EUR) ÷ the average price. Cached for 6 hours.
 */
import https from 'node:https';
import { gunzipSync } from 'node:zlib';

const URL0 = 'https://portal.mvp.bafin.de/database/DealingsInfo/sucheForm.do';
const TTL = 6 * 60 * 60 * 1000;
const cache = new Map();
const ROLE = { Vorstand: 'management board', Aufsichtsrat: 'supervisory board', Geschäftsführung: 'management',
               'In enger Beziehung': 'closely associated person' };

const num = s => { const v = parseFloat(String(s ?? '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.')); return Number.isFinite(v) ? v : null; };
const iso = s => { const m = String(s ?? '').match(/(\d{2})\.(\d{2})\.(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };

// BaFin folds its security headers over several lines, which fetch() refuses: node's lenient parser reads them
const get = url => new Promise((ok, no) => {
  const req = https.get(url, { insecureHTTPParser: true, headers: { 'user-agent': 'Mozilla/5.0' }, timeout: 15000 }, res => {
    const parts = [];
    res.on('data', c => parts.push(c));
    res.on('end', () => {
      if (res.statusCode !== 200) return no(new Error(`BaFin ${res.statusCode}`));
      const body = Buffer.concat(parts);
      ok((res.headers['content-encoding'] === 'gzip' ? gunzipSync(body) : body).toString('utf8'));
    });
  });
  req.on('timeout', () => req.destroy(new Error('BaFin timeout')));
  req.on('error', no);
});

export async function dealings(isin, today) {
  const hit = cache.get(isin);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  let value = null;
  try {
    // the search form as the page sends it; without its button field BaFin answers with the HTML page
    const q = new URLSearchParams({ meldepflichtigerName: '', zeitraum: '0', 'd-4000784-e': '1', emittentButton: 'Suche Emittent',
                                    emittentName: '', zeitraumVon: '', emittentIsin: isin, '6578706f7274': '1', zeitraumBis: '' });
    const [, ...lines] = (await get(`${URL0}?${q}`)).replace(/^\uFEFF/, '').trim().split(/\r?\n/);
    const rows = lines.map(l => l.split(';')).filter(c => c.length >= 11 && c[2] === isin).map(c => {
      const price = num(c[7]), volume = num(c[8]);
      return { name: c[3].split(', ').reverse().join(' '), relation: ROLE[c[4]] ?? c[4], date: iso(c[10]) ?? iso(c[9]),
               type: c[6] === 'Kauf' ? 'Buy' : c[6] === 'Verkauf' ? 'Sell' : 'Other', price, shares: price > 0 && volume ? Math.round(volume / price) : null };
    }).filter(t => t.date).sort((a, b) => b.date.localeCompare(a.date));
    const since = days => new Date(Date.parse(today) - days * 864e5).toISOString().slice(0, 10);
    const span = days => {
      const t = rows.filter(x => x.date >= since(days));
      const sum = type => t.filter(x => x.type === type).reduce((s, x) => s + (x.shares ?? 0), 0);
      return { buys: t.filter(x => x.type === 'Buy').length, sells: t.filter(x => x.type === 'Sell').length, bought: sum('Buy'), sold: sum('Sell') };
    };
    value = rows.length ? { m3: span(92), m12: span(366), recent: rows.filter(x => x.type !== 'Other').slice(0, 10), source: 'BaFin' } : null;
  } catch { value = null; }
  cache.set(isin, { at: Date.now(), value });
  return value;
}
