/**
 * Where a share trades in the US, by its ISIN - an identifier lookup, no guessing by names.
 *
 *   usListings(isins)   { [isin]: { ticker: 'ONON', exchange: 'NYSE' } | null }
 *                       null: not on a US exchange (OTC only, like SAPGF, or not in the US at all).
 *                       An ISIN left out could not be looked up right now.
 *
 * Source: OpenFIGI api.openfigi.com/v3/mapping. No key: 25 requests a minute, 10 ISINs each.
 * The answer lists every venue; the primary US exchange is told by its code - a Nasdaq share
 * also prints on NYSE (UN), so Nasdaq's codes count first.
 * Cached in memory for a week.
 */
const TTL = 7 * 24 * 60 * 60 * 1000;
const cache = new Map();
const EXCHANGES = [[['UW', 'UQ', 'UR'], 'Nasdaq'], [['UN'], 'NYSE'], [['UA'], 'NYSE American'], [['UP'], 'NYSE Arca']];

function listing(rows) {
  for (const [codes, exchange] of EXCHANGES) {
    const on = rows.filter(r => codes.includes(r.exchCode));
    const row = on.find(r => ['Common Stock', 'ADR'].includes(r.securityType)) ?? on[0];
    if (row?.ticker) return { ticker: row.ticker, exchange };
  }
  return null;
}

export async function usListings(isins) {
  const out = {}, todo = [];
  for (const i of new Set(isins.filter(Boolean))) {
    const hit = cache.get(i);
    if (hit && Date.now() - hit.at < TTL) out[i] = hit.value; else todo.push(i);
  }
  for (let k = 0; k < todo.length; k += 10) {
    const part = todo.slice(k, k + 10);
    const r = await fetch('https://api.openfigi.com/v3/mapping', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000),
      body: JSON.stringify(part.map(idValue => ({ idType: 'ID_ISIN', idValue }))),
    });
    if (!r.ok) break;                                    // 429: the rest stays unknown, asked again next time
    (await r.json()).forEach((res, j) => {
      if (res.error && !/no identifier found/i.test(res.error)) return;
      const value = listing(res.data ?? []);
      out[part[j]] = value;
      cache.set(part[j], { at: Date.now(), value });
    });
  }
  return out;
}
