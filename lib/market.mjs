/**
 * Prices from onvista's public API. No key.
 *
 * Why onvista: Yahoo answers 429 to anything without a browser session, Stooq wants a
 * JavaScript check. onvista resolves by ISIN, and its quote list carries LS Exchange -
 * the venue Trade Republic itself trades on - so the euros here are the euros in the app.
 *
 *   search(text)   name or ISIN -> instruments
 *   resolve(key)   ISIN (or a crypto ticker like BTC) -> instrument + chosen notation
 *   quote(key)     last / previous close on that notation, cached 5 min
 *   closes(key)    daily closes, cached for the day
 *
 * Everything is cached in memory only. Unofficial API: if onvista changes shape, quote()
 * and closes() throw and the page says so per instrument instead of showing a wrong number.
 */
const BASE  = 'https://api.onvista.de/api/v1';
const UA    = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36';
const QUOTE_TTL = 5 * 60 * 1000;
const PREFERRED = 'LSX';                       // LS Exchange - Trade Republic's venue

const isIsin = k => /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(k);
const today  = () => new Date().toISOString().slice(0, 10);

const instruments = new Map();                 // key -> resolved instrument
const quotes = new Map();                      // key -> {at, q}
const eod = new Map();                         // key -> {day, from, closes}

async function get(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' },
                               signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`onvista ${r.status}`);
  const j = await r.json();
  if (j.errorMessage) throw new Error(`onvista ${j.statusCode || ''} ${j.displayErrorMessage || ''}`.trim());
  return j;
}

/**
 * One of the snapshot's venues, euros only: LS Exchange if listed, else onvista's own
 * default, else the most recent EUR quote. BTCEUR lists a USD Bitfinex line too, and
 * onvista's default does not always point at the EUR one.
 */
function pickNotation(snap, wantId) {
  const list = snap.quoteList?.list ?? [];
  if (wantId) {
    const q = list.find(x => x.market?.idNotation === wantId);
    if (q) return q;
  }
  const eur = list.filter(x => x.isoCurrency === 'EUR');
  return eur.find(x => x.market?.codeExchange === PREFERRED)
      ?? (snap.quote?.isoCurrency === 'EUR' ? snap.quote : null)
      ?? eur.sort((a, b) => String(b.datetimeLast).localeCompare(String(a.datetimeLast)))[0]
      ?? null;
}

/** Free-text or ISIN search, best hit first. */
export async function search(text) {
  const j = await get(`${BASE}/instruments/query?searchValue=${encodeURIComponent(text)}`);
  return (j.list ?? [])
    .filter(x => ['STOCK', 'FUND', 'CRYPTO'].includes(x.entityType))
    .map(x => ({ key: x.isin || x.entityValue, name: x.name, type: x.entityType,
                 entityValue: x.entityValue, isin: x.isin || null }));
}

/** ISIN or crypto ticker -> {entityType, entityValue, idNotation, venue, currency}. */
export async function resolve(key) {
  if (instruments.has(key)) return instruments.get(key);
  let entityType, entityValue;
  if (isIsin(key)) {
    const hit = (await search(key)).find(x => x.isin === key);
    if (!hit) throw new Error(`onvista does not know ${key}`);
    ({ type: entityType, entityValue } = hit);
  } else {                                     // Trade Republic writes crypto as BTC, ETH, ...
    entityType = 'CRYPTO'; entityValue = `${key}EUR`;
  }
  const snap = await get(`${BASE}/instruments/${entityType}/${entityValue}/snapshot`);
  const q = pickNotation(snap);
  if (!q) throw new Error(`no EUR quote for ${key}`);
  const ins = { key, entityType, entityValue, idNotation: q.market.idNotation,
                venue: q.market.name, currency: q.isoCurrency, name: snap.instrument?.name ?? key };
  instruments.set(key, ins);
  return ins;
}

/** Last price and the previous close, on the resolved venue. `maxAge` (ms) for a fresher price. */
export async function quote(key, maxAge = QUOTE_TTL) {
  const hit = quotes.get(key);
  if (hit && Date.now() - hit.at < maxAge) return hit.q;
  const ins = await resolve(key);
  const snap = await get(`${BASE}/instruments/${ins.entityType}/${ins.entityValue}/snapshot`);
  const q = pickNotation(snap, ins.idNotation);
  if (!q || !Number.isFinite(q.last)) throw new Error(`no price for ${key}`);
  const out = { last: q.last, prev: q.previousLast ?? null, at: q.datetimeLast ?? null,
                venue: q.market?.name ?? ins.venue, currency: q.isoCurrency ?? ins.currency };
  quotes.set(key, { at: Date.now(), q: out });
  return out;
}

/**
 * Daily closes from `from` on: [[YYYY-MM-DD, close], ...], ascending.
 * Refetched at most once a day; a fetch that fails keeps the last series.
 */
export async function closes(key, from) {
  const have = eod.get(key);
  if (have && have.day === today() && have.from <= from) return have.closes;
  try {
    const ins = await resolve(key);
    const j = await get(`${BASE}/instruments/${ins.entityType}/${ins.entityValue}/eod_history`
                      + `?idNotation=${ins.idNotation}&range=Y5&startDate=${from}`);
    const t = j.datetimeLast ?? [], c = j.last ?? [];
    const series = t.map((s, i) => [new Date(s * 1000).toISOString().slice(0, 10), c[i]])
                    .filter(([, v]) => Number.isFinite(v));
    eod.set(key, { day: today(), from, closes: series });
    return series;
  } catch (e) {
    if (have) return have.closes;
    throw e;
  }
}

/** Run fn over items, at most n at a time - onvista is a courtesy, not a contract. */
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}
