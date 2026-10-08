/**
 * Yahoo Finance for a listed company anywhere - what onvista and, outside the US, Nasdaq do not have.
 *
 *   cashflow(isin)  -> { symbol, currency, years: [{ year, end, operating, capex, free, buybacks,
 *                        dividendsPaid, shares, netIncome }] } oldest first, or null
 *   targets(isin)   -> { symbol, currency, price, target, low, high, analysts, recommendation, evEbitda } or null
 *                      analysts' price targets for any listing, and EV/EBITDA. Price and targets in the
 *                      listing's currency (pence in London), so only their ratio means something.
 *   estimates(isin) -> { symbol, currency, years, quarters, reported, next } or null - see parseEstimates
 *
 * Unofficial and without a key: Yahoo turns away browser and curl user agents (429) but answers a
 * plain one. Four years, in the currency the company reports in. The share count is as reported
 * then - not adjusted for later splits. Every failure gives null: the read-out leaves those lines out.
 * Cached for a day. targets() and estimates() also need a cookie and a "crumb" first - still no key; both
 * are kept until Yahoo turns them away (401), then fetched once more. They share one request per stock.
 */
const UA = 'Mozilla/5.0';
const TTL = 24 * 60 * 60 * 1000;
const cache = new Map(), symbols = new Map(), scache = new Map(), rcache = new Map();
let session = null;                                                 // { cookie, crumb } for quoteSummary
const TYPES = { operating: 'annualOperatingCashFlow', capex: 'annualCapitalExpenditure', free: 'annualFreeCashFlow',
                buybacks: 'annualRepurchaseOfCapitalStock', dividendsPaid: 'annualCashDividendsPaid',
                shares: 'annualOrdinarySharesNumber', netIncome: 'annualNetIncome' };

async function getJson(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Yahoo ${r.status}`);
  return r.json();
}

// the main listing Yahoo finds for an ISIN: its first share ("BIKE.DE" before "BIKE.F")
async function symbolOf(isin) {
  if (!symbols.has(isin)) {
    const found = await getJson(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(isin)}&quotesCount=5&newsCount=0`);
    symbols.set(isin, (found.quotes ?? []).find(q => q.quoteType === 'EQUITY')?.symbol ?? null);
  }
  return symbols.get(isin);
}

export async function cashflow(isin) {
  const hit = cache.get(isin);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  let value = null;
  try {
    const symbol = await symbolOf(isin);
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

async function crumbed() {
  if (session) return session;
  const r = await fetch('https://fc.yahoo.com', { headers: { 'user-agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  const cookie = r.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const c = cookie && await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { 'user-agent': UA, cookie }, signal: AbortSignal.timeout(15000) });
  const crumb = c?.ok ? (await c.text()).trim() : '';
  if (!crumb || crumb.includes('<')) throw new Error('Yahoo: no crumb');
  return (session = { cookie, crumb });
}

async function quoteSummary(symbol, modules, again = true) {
  const { cookie, crumb } = await crumbed();
  const r = await fetch(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`,
                        { headers: { 'user-agent': UA, accept: 'application/json', cookie }, signal: AbortSignal.timeout(15000) });
  if (r.status === 401 && again) { session = null; return quoteSummary(symbol, modules, false); }
  if (!r.ok) throw new Error(`Yahoo ${r.status}`);
  return (await r.json())?.quoteSummary?.result?.[0] ?? null;
}

// one quoteSummary per stock a day, for targets() and estimates(); the promise is kept, so two asking at once ask once
const MODULES = 'financialData,defaultKeyStatistics,price,earningsTrend,earnings,calendarEvents';
function summary(isin) {
  const hit = scache.get(isin);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const value = symbolOf(isin).then(async symbol => (symbol ? { symbol, q: await quoteSummary(symbol, MODULES) } : null)).catch(() => null);
  scache.set(isin, { at: Date.now(), value });
  return value;
}

const raw = v => (v && typeof v === 'object' ? v.raw ?? null : v ?? null);
const ymd = v => (typeof v === 'string' ? v : raw(v) ? new Date(raw(v) * 1000).toISOString().slice(0, 10) : null);

export async function targets(isin) {
  const s = await summary(isin), q = s?.q;
  if (!q) return null;
  const f = q.financialData ?? {}, k = q.defaultKeyStatistics ?? {};
  return { symbol: s.symbol, currency: q.price?.currency ?? null, price: raw(f.currentPrice), target: raw(f.targetMeanPrice),
           low: raw(f.targetLowPrice), high: raw(f.targetHighPrice), analysts: raw(f.numberOfAnalystOpinions),
           recommendation: f.recommendationKey && f.recommendationKey !== 'none' ? f.recommendationKey.replace(/_/g, ' ') : null,
           evEbitda: raw(k.enterpriseToEbitda) };
}

// revenue of the last eight quarters as reported, by period end: what a revenue estimate is held against
async function quarterRevenue(symbol) {
  const hit = rcache.get(symbol);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  let value = [];
  try {
    const now = Math.floor(Date.now() / 1000);
    const d = await getJson(`https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}`
      + `?type=quarterlyTotalRevenue&period1=${now - 2 * 366 * 86400}&period2=${now}`);
    value = (d?.timeseries?.result?.[0]?.quarterlyTotalRevenue ?? []).filter(x => x?.asOfDate && x.reportedValue?.raw != null)
      .map(x => ({ end: x.asOfDate, revenue: x.reportedValue.raw }));
  } catch { value = []; }
  rcache.set(symbol, { at: Date.now(), value });
  return value;
}

export async function estimates(isin) {
  const s = await summary(isin);
  if (!s?.q) return null;
  const e = parseEstimates(s.q, await quarterRevenue(s.symbol));
  return e && { symbol: s.symbol, ...e };
}

// the last day of the month `n` months after `end`: quarters and fiscal years end on a month's last day
const monthsOn = (end, n) => { const [y, m] = end.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + n + 1, 0)).toISOString().slice(0, 10); };

/**
 * Yahoo's quoteSummary -> analysts' estimates, and how the last quarters came out against them. Amounts in
 * the currency the company reports in (`currency`), not the listing's.
 *   years, quarters  [{ end, eps, epsAnalysts, revenue, revenueAnalysts, revenueGrowth (% on the period a year before) }]
 *                    this period and the next, still to be reported
 *   reported         [{ end, date, eps, epsEstimate, revenue }] the last quarters: EPS against the analysts' estimate
 *                    then (Yahoo's), revenue as reported (`revenues`, by period end) - its estimate is not kept by Yahoo
 *   next             { date, estimated } the next results day; estimated: Yahoo's guess, not the company's
 * Right after results Yahoo's period ends can lag its numbers by one period: Micron after 30 Sep 2026 still had
 * "this year" ending Aug 2026 - the year just reported - with Aug 2026's revenue as the year before. A period that
 * ends where results are already out is the next one: moved on a quarter or a year.
 */
export function parseEstimates(q, revenues = []) {
  const ec = q.earnings?.earningsChart ?? {};
  const near = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) <= 10 * 864e5;
  const reported = (ec.quarterly ?? []).map(x => ({ end: ymd(x.periodEndDate), date: ymd(x.reportedDate), eps: raw(x.actual), epsEstimate: raw(x.estimate) }))
    .filter(x => x.end && x.eps != null)
    .map(x => ({ ...x, revenue: revenues.find(r => near(r.end, x.end))?.revenue ?? null }));
  const through = reported.map(x => x.end).sort().at(-1) ?? '';
  const trend = q.earningsTrend?.trend ?? [];
  let currency = q.earnings?.financialCurrency ?? q.financialData?.financialCurrency ?? null;
  const periods = (codes, months) => {
    const list = codes.map(c => trend.find(t => t.period === c)).filter(t => t?.endDate);
    const lag = list[0] && list[0].endDate <= through ? months : 0;
    return list.map(t => {
      const ee = t.earningsEstimate ?? {}, re = t.revenueEstimate ?? {};
      const eps = raw(ee.avg), rev = raw(re.avg) || null, ago = raw(re.yearAgoRevenue);   // revenue 0: none
      currency = ee.earningsCurrency ?? re.revenueCurrency ?? currency;
      return { end: lag ? monthsOn(t.endDate, lag) : t.endDate, eps, epsAnalysts: eps != null ? raw(ee.numberOfAnalysts) : null,
               revenue: rev, revenueAnalysts: rev != null ? raw(re.numberOfAnalysts) || null : null,
               revenueGrowth: rev != null && ago > 0 ? (rev / ago - 1) * 100 : null };
    }).filter(p => p.end > through && (p.eps != null || p.revenue != null));
  };
  const years = periods(['0y', '+1y'], 12), quarters = periods(['0q', '+1q'], 3);
  const ce = q.calendarEvents?.earnings, date = ymd(ce?.earningsDate?.[0]);
  if (!years.length && !quarters.length && !reported.length) return null;
  return { currency, years, quarters, reported, next: date ? { date, estimated: !!ce.isEarningsDateEstimate } : null };
}
