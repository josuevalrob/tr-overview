/**
 * Per-instrument analysis for the sidebar. Public data only, no keys.
 *
 *   analysis(key)   profile, 52-week range, annual financials (+ estimates), dividends,
 *                   and for US-listed shares: analysts, price targets, earnings date,
 *                   last quarters, dividend payments
 *
 * Sources
 *   onvista  /stocks/ISIN:<isin>/figures  ten years of financials, EPS and dividend estimates.
 *            Revenue is not listed in EUR, so it is derived: EBITDA / EBITDA margin. Checked
 *            against the reported USD turnover - the ratio is onvista's FX rate, constant.
 *            Net income = revenue x net margin.
 *   Nasdaq   api.nasdaq.com - US-listed tickers only, so it is used for US ISINs only: the
 *            ticker "NEO" on Nasdaq is NeoGenomics, not Neo Performance Materials (TSX).
 *
 * Cached in memory for 6 hours. Every block can be missing; the page shows what exists.
 */
import { resolve, closes } from './market.mjs';

const UA  = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36';
const TTL = 6 * 60 * 60 * 1000;
const cache = new Map();

async function getJson(url, headers = {}) {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json', ...headers },
                               signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}`);
  return r.json();
}

const usd = s => { const v = parseFloat(String(s ?? '').replace(/[$,\s]/g, '')); return Number.isFinite(v) ? v : null; };
const usDate = s => { const m = String(s ?? '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null; };

/** onvista figures -> one row per year, estimates flagged. Amounts in EUR. */
function annual(fig) {
  const fin = new Map((fig.stocksCnFinancialList?.list ?? []).map(x => [x.label, x]));
  const fun = new Map((fig.stocksCnFundamentalList?.list ?? []).map(x => [x.label, x]));
  const labels = [...new Set([...fin.keys(), ...fun.keys()])].sort();
  return labels.map(label => {
    const f = fin.get(label) ?? {}, u = fun.get(label) ?? {};
    const revenue = f.cnEbitda != null && f.cnEbitdaMa ? f.cnEbitda / (f.cnEbitdaMa / 100) : null;
    return {
      label: label.replace(/e$/, ''), estimate: label.endsWith('e'),        // '2025', '2026e', or fiscal '24/25'
      revenue, ebitda: f.cnEbitda ?? null, ebit: f.cnEbit ?? null,
      netIncome: revenue != null && f.cnMarginNet != null ? revenue * f.cnMarginNet / 100 : null,
      eps: f.cnEpsAdj ?? null, dps: u.cnDps ?? null, divYield: u.cnDivYield ?? null, per: u.cnPer ?? null,
    };
  }).filter(r => [r.revenue, r.ebitda, r.eps, r.dps].some(v => v != null));
}

async function nasdaq(ticker) {
  const N = 'https://api.nasdaq.com/api';
  const t = encodeURIComponent(ticker);
  const [target, rating, earnings, fin, divs, info] = await Promise.allSettled([
    getJson(`${N}/analyst/${t}/targetprice`),
    getJson(`${N}/analyst/${t}/ratings`),
    getJson(`${N}/analyst/${t}/earnings-date`),
    getJson(`${N}/company/${t}/financials?frequency=2`),
    getJson(`${N}/quote/${t}/dividends?assetclass=stocks`),
    getJson(`${N}/quote/${t}/info?assetclass=stocks`),
  ]);
  const ok = p => (p.status === 'fulfilled' ? p.value?.data : null);

  const c = ok(target)?.consensusOverview;
  const price = usd(ok(info)?.primaryData?.lastSalePrice);
  const analysts = c && (c.buy + c.hold + c.sell) > 0 ? {
    buy: c.buy, hold: c.hold, sell: c.sell, consensus: ok(rating)?.meanRatingType ?? null,
    target: c.priceTarget, low: c.lowPriceTarget, high: c.highPriceTarget, currency: 'USD', price,
    upside: price && c.priceTarget ? (c.priceTarget / price - 1) * 100 : null,
  } : null;

  // "...is estimated to report earnings on 10/29/2026..."
  const earningsDate = usDate(ok(earnings)?.reportText);

  // income statement, last quarters - values are in thousands of USD
  let quarterly = null;
  const tbl = ok(fin)?.incomeStatementTable;
  if (tbl?.headers && tbl.rows) {
    const cols = Object.keys(tbl.headers).filter(k => k !== 'value1');
    const row = label => tbl.rows.find(r => r.value1 === label);
    const rev = row('Total Revenue'), net = row('Net Income'), ebit = row('Earnings Before Interest and Tax');
    quarterly = cols.map(k => ({
      period: usDate(tbl.headers[k]),
      revenue: rev ? usd(rev[k]) * 1000 : null,
      ebit: ebit ? usd(ebit[k]) * 1000 : null,
      netIncome: net ? usd(net[k]) * 1000 : null,
    })).filter(q => q.period && q.revenue != null).sort((a, b) => a.period.localeCompare(b.period));
    if (!quarterly.length) quarterly = null;
  }

  const rows = ok(divs)?.dividends?.rows ?? [];
  const dividends = rows.slice(0, 8).map(r => ({
    exDate: usDate(r.exOrEffDate), payDate: usDate(r.paymentDate), amount: usd(r.amount), currency: 'USD',
  })).filter(r => r.exDate && r.amount != null);

  return { ticker, analysts, earningsDate, quarterly, dividends };
}

export async function analysis(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;

  const ins = await resolve(key);
  const out = { key, name: ins.name, type: ins.entityType, isin: /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(key) ? key : null,
                profile: null, range: null, annual: [], us: null, notes: [] };

  // 52 weeks of EUR closes on the same venue as the live price
  try {
    const from = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
    const s = (await closes(key, from)).filter(([d]) => d >= from).map(([, v]) => v);
    if (s.length) out.range = { low: Math.min(...s), high: Math.max(...s), currency: 'EUR' };
  } catch { /* no history - no range bar */ }

  if (ins.entityType !== 'STOCK' || !out.isin) {
    out.notes.push(ins.entityType === 'CRYPTO' ? 'No company data for crypto.' : 'No company data for funds and ETFs.');
  } else {
    const B = 'https://api.onvista.de/api/v1/stocks';
    const [snap, fig] = await Promise.allSettled([
      getJson(`${B}/ISIN:${key}/snapshot`), getJson(`${B}/ISIN:${key}/figures`),
    ]);
    if (snap.status === 'fulfilled') {
      const s = snap.value;
      out.profile = {
        sector: s.company?.branch?.sector?.name ?? null, branch: s.company?.branch?.name ?? null,
        country: s.company?.nameCountry ?? null,
        marketCap: s.stocksFigure?.marketCapCompany ?? null, marketCapCurrency: s.stocksFigure?.isoCurrency ?? null,
        symbol: s.instrument?.homeSymbol ?? null,
      };
    }
    if (fig.status === 'fulfilled') out.annual = annual(fig.value);
    else out.notes.push('Financials unavailable right now.');

    if (key.startsWith('US') && out.profile?.symbol) {
      try { out.us = await nasdaq(out.profile.symbol); }
      catch { out.notes.push('Analyst data unavailable right now.'); }
    } else {
      out.notes.push('Analysts, earnings dates and quarterly figures: US-listed shares only.');
    }
  }
  cache.set(key, { at: Date.now(), value: out });
  return out;
}
