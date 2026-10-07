/**
 * Euro reference rates and the euro area's 10-year yield from the ECB - public, no key.
 *
 *   rates()   { date, fx: { USD: 1.1269, CAD: 1.6058, ... } per 1 €, bond10y: 3.52 (%, AAA euro area) }
 *   toEur(v, currency, fx)   an amount in euros at those rates, or null for an unknown currency
 *
 * Cached for 12 hours; a failure gives null and the read-out leaves those comparisons out.
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
  if (cached && Date.now() - cached.at < TTL) return cached.value;
  try {
    const [ex, yc] = await Promise.all([
      csv('EXR/D..EUR.SP00.A?lastNObservations=1'),
      csv('YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y?lastNObservations=1'),
    ]);
    const fx = { EUR: 1 };
    for (const r of ex) if (Number(r.OBS_VALUE) > 0) fx[r.CURRENCY] = Number(r.OBS_VALUE);
    const value = { date: ex.map(r => r.TIME_PERIOD).sort().at(-1) ?? null, fx, bond10y: Number(yc[0]?.OBS_VALUE) || null };
    cached = { at: Date.now(), value };
    return value;
  } catch { return null; }
}

export const toEur = (v, currency, fx) => (v == null || !fx?.[currency] ? null : v / fx[currency]);
