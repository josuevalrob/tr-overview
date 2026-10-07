/**
 * Yahoo Finance's yearly cash-flow lines for a listed company anywhere - what onvista and, outside
 * the US, Nasdaq do not have: free cash flow, buybacks, dividends paid, the share count.
 *
 *   cashflow(isin) -> { symbol, currency, years: [{ year, end, operating, capex, free, buybacks,
 *                       dividendsPaid, shares, netIncome }] } oldest first, or null
 *
 * Unofficial and without a key: Yahoo turns away browser and curl user agents (429) but answers a
 * plain one. Four years, in the currency the company reports in. The share count is as reported
 * then - not adjusted for later splits. Every failure gives null: the read-out leaves those lines out.
 * Cached for a day.
 */
const UA = 'Mozilla/5.0';
const TTL = 24 * 60 * 60 * 1000;
const cache = new Map();
const TYPES = { operating: 'annualOperatingCashFlow', capex: 'annualCapitalExpenditure', free: 'annualFreeCashFlow',
                buybacks: 'annualRepurchaseOfCapitalStock', dividendsPaid: 'annualCashDividendsPaid',
                shares: 'annualOrdinarySharesNumber', netIncome: 'annualNetIncome' };

async function getJson(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Yahoo ${r.status}`);
  return r.json();
}

export async function cashflow(isin) {
  const hit = cache.get(isin);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  let value = null;
  try {
    const found = await getJson(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(isin)}&quotesCount=5&newsCount=0`);
    const symbol = (found.quotes ?? []).find(q => q.quoteType === 'EQUITY')?.symbol;
    if (symbol) {
      const now = Math.floor(Date.now() / 1000);
      const d = await getJson(`https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}`
        + `?type=${Object.values(TYPES).join(',')}&period1=${now - 6 * 366 * 86400}&period2=${now}`);
      const by = new Map();
      let currency = null;
      for (const r of d?.timeseries?.result ?? []) {
        const type = r.meta?.type?.[0], field = Object.keys(TYPES).find(k => TYPES[k] === type);
        for (const x of (field && r[type]) || []) {
          if (!x?.asOfDate || x.reportedValue?.raw == null) continue;
          const y = by.get(x.asOfDate) ?? { year: x.asOfDate.slice(0, 4), end: x.asOfDate };
          y[field] = x.reportedValue.raw;
          if (field !== 'shares') currency ??= x.currencyCode ?? null;
          by.set(x.asOfDate, y);
        }
      }
      const years = [...by.values()].sort((a, b) => a.end.localeCompare(b.end))
        .map(y => ({ ...y, free: y.free ?? (y.operating != null ? y.operating + (y.capex ?? 0) : null) }));
      if (years.some(y => y.free != null)) value = { symbol, currency, years };
    }
  } catch { value = null; }
  cache.set(isin, { at: Date.now(), value });
  return value;
}
