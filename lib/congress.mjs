/**
 * Members of the US Congress who bought a stock: the House's and the Senate's periodic transaction reports
 * (STOCK Act - every trade over 1.000 $, filed within 45 days), as Bargo parses them. Only the US has such
 * reports: EU and national parliaments in Europe declare holdings once a year or term, not trades.
 *
 *   congressBuys(ticker, today) -> [{ member, chamber, state, date, disclosed, amount, low, high }] newest first, or null
 *   buysOf(trades)              purchases only, one row per member, day and amount (a filing can list one twice)
 *
 * Source: www.bargo.ai/free-apis/congress, no key: 30 requests and 100 rows a day per IP, the last 3 months.
 * Their terms ask for a visible credit where the data shows - the read-out names Bargo. Kept in data/congress.json
 * a week per ticker (a report lags the trade by up to 45 days anyway, and the day's requests are few).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.join(process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data'), 'congress.json');
const WEEK = 7 * 24 * 60 * 60 * 1000;
const read = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } };

export function buysOf(trades) {
  const seen = new Set(), out = [];
  for (const t of trades ?? []) {
    if (t.type !== 'purchase' || !t.member || !t.transaction_date) continue;
    const k = `${t.member}|${t.transaction_date}|${t.amount_range}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ member: t.member, chamber: t.chamber === 'senate' ? 'Senate' : 'House', state: t.state ?? null,
               date: t.transaction_date, disclosed: t.disclosure_date ?? null, amount: t.amount_range ?? null,
               low: t.amount_low ?? null, high: t.amount_high ?? null });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

export async function congressBuys(ticker, now = Date.now()) {
  const t = String(ticker ?? '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(t)) return null;
  const all = read(), hit = all[t];
  if (hit && now - hit.at < WEEK) return hit.buys;
  const r = await fetch(`https://www.bargo.ai/free-apis/congress/v1/trades?ticker=${encodeURIComponent(t)}&type=purchase&limit=20`,
                        { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Bargo ${r.status}`);                     // 429: the day's 30 requests are used - next time
  const buys = buysOf((await r.json()).trades);
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify({ ...read(), [t]: { at: now, buys } }, null, 1) + '\n'); }
  catch { /* no cache: asked again next time */ }
  return buys;
}
