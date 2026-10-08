/**
 * A Trade Republic depot, walked forward from its transaction exports.
 *
 *   loadAll(dir)               every export in the data folder, merged
 *   mergeExports(files)        CSV texts, merged, deduped by transaction_id
 *   replay(rows, until)        cash, open FIFO lots, sales, income - as of a date
 *   positionsNow(st, quotes)   open positions marked to market
 *   months(rows, closes, q)    month-end value, cash, paid in, and what the month earned
 *   annualReturns(rows, ...)   return per year, counting when money went in (XIRR)
 *   taxYear(rows, year, ...)   the Sparer-Pauschbetrag, and the tax past it
 *   currencySplit(pos, fx)     gain since bought: the price in its own currency vs that currency
 *
 * Conventions of the export, all of them easy to get wrong:
 *   - integer cents for money, floats for shares and prices
 *   - `fee` and `tax` sit OUTSIDE `amount`; cash moves by amount + fee + tax
 *   - `shares` is already signed: a SELL carries negative shares
 *   - TAX_OPTIMIZATION has amount 0,00 and the refund in the `tax` column
 * Cost basis is FIFO, which is what § 20 Abs. 4 S. 7 EStG prescribes for a German depot.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseCsv, toCents } from './csv.mjs';

export const CRYPTO_LIMIT = 100000;      // § 23 Abs. 3 EStG since 2024 - a Freigrenze, not a Freibetrag
const EPS = 1e-6;

const num = s => { const v = parseFloat(String(s ?? '').trim()); return Number.isFinite(v) ? v : 0; };
const ym  = d => d.slice(0, 7);

/**
 * Tax settings -> allowance in cents and the flat rate on capital income.
 * With church tax the 25 % is reduced first (§ 32d Abs. 1 EStG), then Soli and
 * Kirchensteuer are charged on what is left: 9 % -> 27,995 %, 8 % -> 27,819 %.
 */
export function taxSettings({ joint = false, church = 0 } = {}) {
  const k = [0, 0.08, 0.09].includes(Number(church)) ? Number(church) : 0;
  const kest = 0.25 / (1 + 0.25 * k);
  return { allowance: joint ? 200000 : 100000, rate: kest * (1 + 0.055 + k), joint: !!joint, church: k };
}

// ---------------------------------------------------------------- reading

const NEEDED = ['datetime', 'date', 'type', 'amount', 'transaction_id'];

export function isTrExport(text) {
  const head = String(text).replace(/^﻿/, '').split('\n', 1)[0].toLowerCase();
  const cols = head.split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  return NEEDED.every(h => cols.includes(h)) && cols.includes('account_type');
}

export function parseExport(text) {
  const rows = parseCsv(String(text), ',');
  const hdr = rows[0].map(h => h.trim().toLowerCase());
  const ix = n => hdr.indexOf(n);
  const c = Object.fromEntries(['datetime', 'date', 'category', 'type', 'asset_class', 'name', 'symbol',
    'shares', 'price', 'amount', 'fee', 'tax', 'transaction_id'].map(n => [n, ix(n)]));
  const v = (r, n) => (c[n] >= 0 ? (r[c[n]] ?? '') : '').trim();
  return rows.slice(1)
    .filter(r => /^\d{4}-\d{2}-\d{2}$/.test(v(r, 'date')))
    .map(r => ({
      id: v(r, 'transaction_id'), at: v(r, 'datetime') || v(r, 'date'), date: v(r, 'date'),
      category: v(r, 'category'), type: v(r, 'type'), assetClass: v(r, 'asset_class'),
      name: v(r, 'name'), key: v(r, 'symbol'),
      shares: num(v(r, 'shares')), price: num(v(r, 'price')),
      amount: toCents(v(r, 'amount') || '0'), fee: toCents(v(r, 'fee') || '0'), tax: toCents(v(r, 'tax') || '0'),
    }));
}

const altKey = r => `${r.at}|${r.type}|${r.amount}|${r.key}|${r.shares}`;

/**
 * Exports overlap - each one is a date range the user picked. Rows are merged by
 * transaction_id, and by datetime+type+amount+symbol as a second key, so a re-export
 * that renumbered a row still cannot count it twice.
 *
 * files: [{name, text}] -> {rows, files: [{name, ok, rows, added, reason}], first, last}
 */
export function mergeExports(files) {
  const seen = new Set(), rows = [], report = [];
  for (const f of files) {
    if (!isTrExport(f.text)) { report.push({ name: f.name, ok: false, reason: 'not a Trade Republic transaction export' }); continue; }
    const parsed = parseExport(f.text);
    let added = 0;
    for (const r of parsed) {
      if ((r.id && seen.has(r.id)) || seen.has(altKey(r))) continue;
      if (r.id) seen.add(r.id);
      seen.add(altKey(r));
      rows.push(r); added++;
    }
    report.push({ name: f.name, ok: true, rows: parsed.length, added });
  }
  rows.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  return { rows, files: report, first: rows[0]?.date ?? null, last: rows.at(-1)?.date ?? null };
}

/** Every export in a folder, merged. */
export function loadAll(dir) {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.csv')).sort() : [];
  const m = mergeExports(files.map(f => ({ name: f, text: fs.readFileSync(path.join(dir, f), 'utf8') })));
  return { ...m, files: m.files.filter(f => f.ok).map(f => f.name) };
}

// ---------------------------------------------------------------- the ledger

/** Everything the account knows as of `until` (inclusive). */
export function replay(rows, until = '9999-12-31') {
  const st = { cash: 0, paidIn: 0, lots: new Map(), meta: new Map(), sales: [], income: [], refunds: [] };
  const lots = k => { if (!st.lots.has(k)) st.lots.set(k, []); return st.lots.get(k); };
  for (const r of rows) {
    if (r.date > until) break;
    st.cash += r.amount + r.fee + r.tax;
    if (r.key) st.meta.set(r.key, { name: r.name || st.meta.get(r.key)?.name || r.key,
                                    assetClass: r.assetClass || st.meta.get(r.key)?.assetClass || '' });
    if (r.type === 'BUY') {
      lots(r.key).push({ date: r.date, shares: r.shares, cost: -r.amount - r.fee });
    } else if (r.type === 'SELL') {
      const q = lots(r.key), parts = [];
      let left = Math.abs(r.shares), cost = 0;
      while (left > EPS && q.length) {
        const l = q[0], take = Math.min(left, l.shares);
        const c = take >= l.shares - EPS ? l.cost : Math.round(l.cost * take / l.shares);
        parts.push({ bought: l.date, shares: take, cost: c });
        cost += c; l.cost -= c; l.shares -= take; left -= take;
        if (l.shares <= EPS) q.shift();
      }
      const proceeds = r.amount + r.fee;                 // the order fee is negative
      st.sales.push({ date: r.date, key: r.key, name: st.meta.get(r.key)?.name ?? r.name,
                      assetClass: st.meta.get(r.key)?.assetClass ?? r.assetClass,
                      shares: Math.abs(r.shares), proceeds, cost, gain: proceeds - cost, tax: r.tax, parts,
                      // sold more than the exports ever bought: the buy is older than the data
                      incomplete: left > EPS });
    } else if (r.type === 'INTEREST_PAYMENT' || r.type === 'DIVIDEND') {
      st.income.push({ date: r.date, type: r.type, key: r.key, name: r.name, gross: r.amount, tax: r.tax });
    } else if (r.type === 'TAX_OPTIMIZATION') {
      st.refunds.push({ date: r.date, amount: r.amount + r.tax });
    } else {
      // everything else on the cash side is money crossing the account boundary:
      // transfers in and out, card spend
      st.paidIn += r.amount + r.fee + r.tax;
    }
  }
  return st;
}

/** Open lots folded into positions, at cost. */
export function holdings(st) {
  const out = [];
  for (const [key, q] of st.lots) {
    const shares = q.reduce((s, l) => s + l.shares, 0);
    if (shares <= EPS) continue;
    const m = st.meta.get(key) ?? { name: key, assetClass: '' };
    out.push({ key, name: m.name, assetClass: m.assetClass, shares,
               cost: q.reduce((s, l) => s + l.cost, 0), lots: q.map(l => ({ ...l })) });
  }
  return out;
}

/** Marked to market. A missing quote leaves value null - never a guessed number. */
export function positionsNow(st, quotes) {
  const list = holdings(st).map(h => {
    const q = quotes[h.key];
    if (!q || q.error) return { ...h, error: q?.error ?? 'no quote', value: null };
    const value = Math.round(h.shares * q.last * 100);
    const day = q.prev != null ? Math.round(h.shares * (q.last - q.prev) * 100) : null;
    return { ...h, last: q.last, prev: q.prev, at: q.at, venue: q.venue, currency: q.currency,
             value, day, dayPct: q.prev ? (q.last / q.prev - 1) * 100 : null,
             gain: value - h.cost, gainPct: h.cost ? (value / h.cost - 1) * 100 : null };
  });
  const valued = list.filter(p => p.value != null);
  const value = valued.reduce((s, p) => s + p.value, 0);
  for (const p of list) p.weight = p.value != null && value ? (p.value / value) * 100 : null;
  list.sort((a, b) => (b.value ?? b.cost) - (a.value ?? a.cost));
  const dayBase = valued.reduce((s, p) => s + (p.day != null ? p.value - p.day : 0), 0);
  const day = valued.reduce((s, p) => s + (p.day ?? 0), 0);
  return {
    positions: list,
    value, cost: valued.reduce((s, p) => s + p.cost, 0),
    day, dayPct: dayBase ? (day / dayBase) * 100 : null,
    missing: list.filter(p => p.value == null).map(p => p.name),
  };
}

// ---------------------------------------------------------------- month by month

const monthEnd = m => {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
};

/** Last close on or before `date`; null if the series starts later. */
function closeAt(series, date) {
  let lo = 0, hi = (series?.length ?? 0) - 1, best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid][0] <= date) { best = series[mid][1]; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

/**
 * One row per month. `result` is what the month earned: the change in total value
 * after taking out money paid in or out. It splits into interest + dividends + taxes +
 * fees + market, and market is the residual - price moves, realised or not.
 */
export function months(rows, closes, quotes, today) {
  if (!rows.length) return [];
  const out = [];
  let prevTotal = 0, prevPaidIn = 0;
  for (let m = ym(rows[0].date); m <= ym(today); ) {
    const end = monthEnd(m) < today ? monthEnd(m) : today;
    const st = replay(rows, end);
    let value = 0, cost = 0;
    const estimated = [];
    for (const h of holdings(st)) {
      const live = end === today && quotes[h.key] && !quotes[h.key].error ? quotes[h.key].last : null;
      const px = live ?? closeAt(closes[h.key], end);
      cost += h.cost;
      if (px == null) { value += h.cost; estimated.push(h.name); } else value += Math.round(h.shares * px * 100);
    }
    const inMonth = rows.filter(r => ym(r.date) === m);
    const sum = (f, k) => inMonth.filter(f).reduce((s, r) => s + r[k], 0);
    const paidIn = st.paidIn - prevPaidIn;
    const total = st.cash + value;
    const interest = sum(r => r.type === 'INTEREST_PAYMENT', 'amount');
    const dividends = sum(r => r.type === 'DIVIDEND', 'amount');
    const taxes = sum(() => true, 'tax'), fees = sum(() => true, 'fee');
    const result = total - prevTotal - paidIn;
    const base = prevTotal + Math.max(0, paidIn);
    out.push({ month: m, end, cash: st.cash, value, cost, total, paidIn, paidInTotal: st.paidIn,
               interest, dividends, taxes, fees, result,
               market: result - interest - dividends - taxes - fees,
               returnPct: base > 0 ? (result / base) * 100 : null,
               estimated, partial: end === today });
    prevTotal = total; prevPaidIn = st.paidIn;
    const [y, mo] = m.split('-').map(Number);
    m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
  }
  return out;
}

// ---------------------------------------------------------------- per year

const YEAR = 365.25 * 864e5;

/**
 * The money-weighted return per year (XIRR): the one rate at which every euro put in and
 * taken out, grown to `end`, nets against what is there on `end`. It counts when money
 * went in - a buy last week weighs a week, not the whole period. Flows are [date, cents]
 * from the investor's side: paid in < 0, taken out > 0. null when it does not solve.
 */
export function xirr(flows, end, endValue) {
  const t1 = Date.parse(end);
  const fv = r => flows.reduce((s, [d, c]) => s + c * (1 + r) ** ((t1 - Date.parse(d)) / YEAR), endValue);
  let lo = -0.99, hi = 10;
  if (!flows.length || Math.sign(fv(lo)) === Math.sign(fv(hi))) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (Math.sign(fv(mid)) === Math.sign(fv(lo))) lo = mid; else hi = mid;
  }
  return ((lo + hi) / 2) * 100;
}

/**
 * Return per year since the first euro, two ways: everything at Trade Republic (money paid
 * in vs cash + stocks now) and stocks + crypto alone (buys and sells vs market value now).
 * Under a year of data `pct` is null - an annualised month is noise.
 */
export function annualReturns(rows, today, total, value) {
  const one = (flows, endValue) => {
    const since = flows[0]?.[0] ?? null;
    const years = since ? (Date.parse(today) - Date.parse(since)) / YEAR : 0;
    return { since, years, pct: years >= 1 ? xirr(flows, today, endValue) : null };
  };
  const BOOKED = new Set(['BUY', 'SELL', 'INTEREST_PAYMENT', 'DIVIDEND', 'TAX_OPTIMIZATION']);
  return {
    all: one(rows.filter(r => !BOOKED.has(r.type)).map(r => [r.date, -(r.amount + r.fee + r.tax)]), total),
    stocks: one(rows.filter(r => r.type === 'BUY' || r.type === 'SELL').map(r => [r.date, r.amount + r.fee]), value),
  };
}

// ---------------------------------------------------------------- day by day

/** Every buy and sell, per instrument - the dots on a price chart. */
export function trades(rows) {
  const out = {};
  for (const r of rows) {
    if (r.type !== 'BUY' && r.type !== 'SELL') continue;
    (out[r.key] ??= []).push({ date: r.date, type: r.type, shares: Math.abs(r.shares), price: r.price,
                               amount: -(r.amount + r.fee) });
  }
  return out;
}

/**
 * Stocks + crypto, one point per day that has a price: market value, what the open lots
 * cost, and gains already realised. value - cost + realised is the whole result, so a
 * sale does not look like a loss on the day it happens.
 */
export function daily(rows, closes, quotes, today) {
  const trade = rows.filter(r => r.type === 'BUY' || r.type === 'SELL');
  if (!trade.length) return [];
  const days = new Set([today]);
  for (const s of Object.values(closes)) for (const [d] of s ?? []) if (d >= trade[0].date && d <= today) days.add(d);
  const out = [];
  for (const d of [...days].sort()) {
    const st = replay(trade, d);
    let value = 0, cost = 0;
    for (const h of holdings(st)) {
      const live = d === today && quotes[h.key] && !quotes[h.key].error ? quotes[h.key].last : null;
      const px = live ?? closeAt(closes[h.key], d);
      cost += h.cost;
      value += px == null ? h.cost : Math.round(h.shares * px * 100);
    }
    out.push({ d, value, cost, realised: st.sales.reduce((s, x) => s + x.gain, 0) });
  }
  return out;
}

// ---------------------------------------------------------------- tax

const addYear = d => {                       // tax-free from the day AFTER one full year
  const t = new Date(d + 'T00:00:00Z');
  t.setUTCFullYear(t.getUTCFullYear() + 1);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
};

function pot(interest, dividends, stockNet, { allowance, rate }) {
  // stock losses only offset stock gains (§ 20 Abs. 6 S. 4 EStG) - the rest waits in
  // the Aktienverlusttopf and never touches interest
  const capital = interest + dividends + Math.max(0, stockNet);
  const over = Math.max(0, capital - allowance);
  return { capital, used: Math.min(capital, allowance), left: Math.max(0, allowance - capital),
           over, tax: Math.round(over * rate) };
}

/**
 * The Sparer-Pauschbetrag for one calendar year, this account only.
 * `pos` (current year only) is positionsNow() - it prices the "sell everything" line and
 * the crypto holding periods.
 */
export function taxYear(rows, year, pos, today, settings = taxSettings()) {
  const y = String(year);
  const st = replay(rows);
  const inY = r => r.date.startsWith(y);
  const inc = st.income.filter(inY);
  const interest = inc.filter(r => r.type === 'INTEREST_PAYMENT');
  const divs = inc.filter(r => r.type === 'DIVIDEND');
  const sales = st.sales.filter(inY);
  const stockSales = sales.filter(s => s.assetClass !== 'CRYPTO');
  const cryptoSales = sales.filter(s => s.assetClass === 'CRYPTO');
  const sumK = (a, k) => a.reduce((s, r) => s + r[k], 0);

  const interestGross = sumK(interest, 'gross'), dividendGross = sumK(divs, 'gross');
  const stockGains = stockSales.filter(s => s.gain > 0).reduce((s, x) => s + x.gain, 0);
  const stockLosses = stockSales.filter(s => s.gain < 0).reduce((s, x) => s + x.gain, 0);
  const stockNet = stockGains + stockLosses;
  const now = pot(interestGross, dividendGross, stockNet, settings);

  const withheld = sumK(inc, 'tax') + sumK(sales, 'tax');
  const refunded = sumK(st.refunds.filter(inY), 'amount');

  // § 23: only the part of a sale held one year or less counts, against its own 1.000 €
  const cryptoShort = cryptoSales.reduce((s, x) => s + x.parts.reduce((a, p) => {
    const share = x.cost ? p.cost / x.cost : 1;
    return a + (addYear(p.bought) > x.date ? Math.round(x.gain * share) : 0);
  }, 0), 0);

  const out = {
    year: Number(y), allowance: settings.allowance, rate: settings.rate,
    interest: { gross: interestGross, n: interest.length },
    dividends: { gross: dividendGross, n: divs.length },
    sales: stockSales.map(({ parts, ...s }) => s),
    stockGains, stockLosses, stockNet, lossCarried: Math.min(0, stockNet),
    ...now, withheld, refunded,
    crypto: { sales: cryptoSales.map(({ parts, ...s }) => s), shortTermGain: cryptoShort,
              limit: CRYPTO_LIMIT, taxable: cryptoShort >= CRYPTO_LIMIT },
  };

  if (y !== today.slice(0, 4)) return out;

  // ---- the rest of this year, estimated
  // Interest for a month lands on the 1st of the next, so after the last one booked the
  // payments still to come are the 1sts of the following months up to 1 December.
  const lastInt = interest.at(-1);
  const intToCome = lastInt ? 12 - Number(lastInt.date.slice(5, 7)) : 0;
  const dataMonths = Math.max(1, Number((st.income.at(-1)?.date ?? today).slice(5, 7)));
  const projInterest = intToCome * (lastInt?.gross ?? 0);
  const projDividends = Math.round((dividendGross / dataMonths) * (12 - dataMonths));
  out.projection = {
    interestPayments: intToCome, interestEach: lastInt?.gross ?? 0,
    interest: projInterest, dividends: projDividends,
    ...pot(interestGross + projInterest, dividendGross + projDividends, stockNet, settings),
  };

  if (pos) {
    const stocks = pos.positions.filter(p => p.assetClass !== 'CRYPTO' && p.value != null);
    const unrealised = stocks.reduce((s, p) => s + p.gain, 0) - 100 * stocks.length;   // 1 € order fee per sale
    const proj = out.projection;
    out.sellAll = { unrealised, ...pot(interestGross + proj.interest, dividendGross + proj.dividends, stockNet + unrealised, settings) };
    out.crypto.open = pos.positions.filter(p => p.assetClass === 'CRYPTO').flatMap(p => p.lots.map(l => {
      const value = p.last != null ? Math.round(l.shares * p.last * 100) : null;
      const free = addYear(l.date);
      return { name: p.name, bought: l.date, shares: l.shares, cost: l.cost, value,
               gain: value != null ? value - l.cost : null, taxFreeFrom: free, taxFree: free <= today,
               daysLeft: Math.max(0, Math.round((Date.parse(free) - Date.parse(today)) / 864e5)) };
    }));
  }
  return out;
}

export const years = rows => [...new Set(rows.map(r => r.date.slice(0, 4)))].map(Number).sort();

// ---------------------------------------------------------------- the price or the currency

/**
 * A guess at the currency a share's price is made in, by the country of its ISIN (an ADR has a US one):
 * 'EUR' for the euro area, null for crypto and countries not listed. Only for when its main listing is
 * unknown - that is the answer (`mainListing` in analysis.mjs): On (Swiss ISIN) trades in dollars.
 */
const HOME = { US: 'USD', CA: 'CAD', GB: 'GBP', CH: 'CHF', JP: 'JPY', DK: 'DKK', SE: 'SEK', NO: 'NOK', AU: 'AUD', HK: 'HKD', PL: 'PLN' };
const EURO = new Set(['DE', 'FR', 'NL', 'BE', 'AT', 'IT', 'ES', 'PT', 'FI', 'IE', 'LU', 'GR', 'SK', 'SI', 'EE', 'LV', 'LT', 'MT', 'CY', 'HR']);
export const homeCurrency = key => !/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(key ?? '') ? null
  : EURO.has(key.slice(0, 2)) ? 'EUR' : HOME[key.slice(0, 2)] ?? null;

/**
 * Gain since bought in two parts (cents): what the price did in its own currency, and what that
 * currency did against the euro. Each open lot at the ECB rate of its buy day (rates per 1 €):
 *   fromCurrency = value × (1 − rate now ÷ rate then),   fromPrice = gain − fromCurrency
 * A euro share, crypto or no rates: all of it is price. fxMove: the currency against the euro
 * since bought, % - the rate paid at weighted by what each lot cost. `homeOf`: key -> its price's currency.
 */
export function currencySplit(positions, fx, homeOf = homeCurrency) {
  return positions.map(p => {
    if (p.value == null) return p;
    const home = homeOf(p.key), s = home && home !== 'EUR' ? fx?.[home] : null, now = s?.at(-1)?.[1];
    if (!now) return { ...p, home, fromPrice: p.gain, fromCurrency: 0 };
    let fromCurrency = 0, paidAt = 0;
    for (const l of p.lots) {
      const then = closeAt(s, l.date) ?? s[0][1];          // a buy before the series: its first rate
      fromCurrency += (p.value * l.shares / p.shares) * (1 - now / then);
      paidAt += l.cost * then;
    }
    fromCurrency = Math.round(fromCurrency);
    const then = p.cost ? paidAt / p.cost : null;
    return { ...p, home, fxThen: then, fxNow: now, fxAsOf: s.at(-1)[0], fxMove: then ? (then / now - 1) * 100 : null,
             fromPrice: p.gain - fromCurrency, fromCurrency };
  });
}

/**
 * Today's move in the same two parts (cents), against yesterday's close - live rates per 1 €
 * ({ USD: { now, prev, at } }, `fxNow` in market.mjs):
 *   dayFromCurrency = value × (1 − rate now ÷ rate at yesterday's close),   dayFromPrice = day − dayFromCurrency
 * A euro share, crypto or no live rate: all of it is price. fxDayMove: the currency against the euro today, %.
 */
export function currencyToday(positions, live, homeOf = homeCurrency) {
  return positions.map(p => {
    if (p.value == null || p.day == null) return p;
    const home = homeOf(p.key), r = home && home !== 'EUR' ? live?.[home] : null;
    if (!r) return { ...p, dayFromPrice: p.day, dayFromCurrency: 0 };
    const dayFromCurrency = Math.round(p.value * (1 - r.now / r.prev));
    return { ...p, fxDayPrev: r.prev, fxDayNow: r.now, fxDayAt: r.at, fxDayMove: (r.prev / r.now - 1) * 100,
             dayFromPrice: p.day - dayFromCurrency, dayFromCurrency };
  });
}
