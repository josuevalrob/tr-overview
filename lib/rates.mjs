/**
 * Euro reference rates and the euro area's 10-year yield from the ECB - public, no key.
 *
 *   rates()   { date, fx: { USD: 1.1269, CAD: 1.6058, ... } per 1 €, bond10y: 3.52 (%, AAA euro area) }
 *   toEur(v, currency, fx)   an amount in euros at those rates, or null for an unknown currency
 *   fxHistory(currencies, from)   every day's rate since `from`, per currency
 *
 * Cached for 12 hours; a source that fails leaves only its own numbers out (null) and is asked again in
 * 10 minutes - the read-out then leaves those comparisons out.
 */
const ECB = 'https://data-api.ecb.europa.eu/service/data';
const TTL = 12 * 60 * 60 * 1000;
let cached = null;

async function csv(path) {
  const r = await fetch(`${ECB}/${path}${path.includes('?') ? '&' : '?'}format=csvdata`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`ECB ${r.status}`);
  const [head, ...lines] = (await r.text()).trim().split('\n');
  const cols = head.split(',');
  return lines.map(l => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v])));
}

export async function rates() {
  if (cached && Date.now() < cached.until) return cached.value;
  // the yield curve timing out (504) is no reason to lose the dollar: each source on its own
  const [ex, yc] = await Promise.allSettled([
    csv('EXR/D..EUR.SP00.A?lastNObservations=1'),
    csv('YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y?lastNObservations=1'),
  ]);
  if (ex.status === 'rejected' && yc.status === 'rejected') return null;
  const rows = ex.value ?? [], fx = { EUR: 1 };
  for (const r of rows) if (Number(r.OBS_VALUE) > 0) fx[r.CURRENCY] = Number(r.OBS_VALUE);
  const value = { date: rows.map(r => r.TIME_PERIOD).sort().at(-1) ?? null, fx, bond10y: Number(yc.value?.[0]?.OBS_VALUE) || null };
  cached = { until: Date.now() + (ex.status === 'fulfilled' && yc.status === 'fulfilled' ? TTL : 10 * 60 * 1000), value };
  return value;
}

export const toEur = (v, currency, fx) => (v == null || !fx?.[currency] ? null : v / fx[currency]);

/**
 * Daily reference rates since `from`, per currency per 1 €: { USD: [['2024-09-02', 1.1066], ...] }
 * oldest first, the euro left out. Cached 12 hours; a failure gives null.
 */
const history = new Map();
export async function fxHistory(currencies, from) {
  const want = [...new Set(currencies)].filter(c => c && c !== 'EUR').sort();
  if (!want.length) return {};
  const id = `${want.join('+')}|${from}`, hit = history.get(id);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  try {
    const value = {};
    for (const r of await csv(`EXR/D.${want.join('+')}.EUR.SP00.A?startPeriod=${from}`))
      if (Number(r.OBS_VALUE) > 0) (value[r.CURRENCY] ??= []).push([r.TIME_PERIOD, Number(r.OBS_VALUE)]);
    for (const s of Object.values(value)) s.sort((a, b) => a[0].localeCompare(b[0]));
    history.set(id, { at: Date.now(), value });
    return value;
  } catch { return null; }
}
