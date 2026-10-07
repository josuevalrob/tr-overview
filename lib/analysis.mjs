/**
 * Per-instrument analysis for the sidebar. Public data only, no keys.
 *
 *   analysis(key)   profile, 52-week range, annual financials (+ estimates, ratios), beta,
 *                   dividends, and for US-listed shares: analysts, price targets, earnings date,
 *                   last quarters, reported years (USD: income, balance sheet, cash flow),
 *                   market value, volume, EPS consensus, PEG, dividend payments, insider
 *                   trades, institutional holders, short interest
 *   tickerName(t)   "SE" -> "Sea Limited": the company behind a US ticker (Nasdaq), or null
 *
 * Sources
 *   onvista  /stocks/ISIN:<isin>/figures  ten years of financials, EPS and dividend estimates,
 *            return on equity, equity ratio, P/B, P/CF, PEG, beta against a benchmark index.
 *            Revenue is not listed in EUR, so it is derived: EBITDA / EBITDA margin. Checked
 *            against the reported USD turnover - the ratio is onvista's FX rate, constant.
 *            Net income = revenue x net margin.
 *   Nasdaq   api.nasdaq.com - US-listed tickers only, so it is used for US ISINs only: the
 *            ticker "NEO" on Nasdaq is NeoGenomics, not Neo Performance Materials (TSX).
 *   FINRA    api.finra.org - short interest of US-listed shares, twice a month, no key.
 *
 * Cached in memory for 6 hours. Every block can be missing; the page shows what exists.
 */
import { resolve, closes } from './market.mjs';

const UA  = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36';
const TTL = 6 * 60 * 60 * 1000;
const cache = new Map();

async function getJson(url, headers = {}, body = null) {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json', ...headers },
                               ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
                               signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
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
      roe: f.cnReturnEquity ?? null, equityRatio: f.cnEquityRatio ?? null, ebitMargin: f.cnEbitMa ?? null,
      cashflow: f.cnCashflow ?? null, pb: u.cnPriceBookvalue ?? null, pcf: u.cnPriceCf ?? null, peg: u.cnPeg ?? null,
      marketCap: u.cnMarketCap ?? f.cnMarketCap ?? null,
    };
  }).filter(r => [r.revenue, r.ebitda, r.eps, r.dps].some(v => v != null));
}

/** Beta over 250 days against onvista's benchmark for the stock (its default, else the first), and volatility. */
function risk(fig) {
  const list = fig.stocksBenchmarkList?.list ?? [], b = list.find(x => x.default) ?? list[0];
  const t = fig.stocksCnTechnical ?? {};
  if (b?.cnBeta250 == null && t.volatility250 == null) return null;
  return { beta: b?.cnBeta250 ?? null, correlation: b?.cnKor250 ?? null, benchmark: b?.instrument?.name ?? null,
           volatility: t.volatility250 ?? null };
}

/** The latest short interest FINRA has for a US-listed ticker, from the last four months. */
async function shortInterest(ticker) {
  const day = d => new Date(d).toISOString().slice(0, 10);
  const rows = await getJson('https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest',
    { 'content-type': 'application/json' },
    { limit: 20, compareFilters: [{ compareType: 'EQUAL', fieldName: 'symbolCode', fieldValue: ticker }],
      dateRangeFilters: [{ fieldName: 'settlementDate', startDate: day(Date.now() - 120 * 864e5), endDate: day(Date.now()) }] });
  const last = (rows ?? []).sort((a, b) => a.settlementDate.localeCompare(b.settlementDate)).at(-1);
  return last ? { date: last.settlementDate, shares: last.currentShortPositionQuantity, previous: last.previousShortPositionQuantity,
                  changePct: last.changePercent, daysToCover: last.daysToCoverQuantity } : null;
}

// Nasdaq financials: row label -> field. Values are thousands of USD.
const INCOME = { revenue: 'Total Revenue', grossProfit: 'Gross Profit', operatingIncome: 'Operating Income',
                 ebit: 'Earnings Before Interest and Tax', pretax: 'Earnings Before Tax', netIncome: 'Net Income' };
const BALANCE = { cash: 'Cash and Cash Equivalents', shortInvestments: 'Short-Term Investments', currentAssets: 'Total Current Assets',
                  totalAssets: 'Total Assets', currentLiabilities: 'Total Current Liabilities',
                  shortDebt: 'Short-Term Debt / Current Portion of Long-Term Debt', longDebt: 'Long-Term Debt',
                  totalLiabilities: 'Total Liabilities', equity: 'Total Equity' };
const CASH = { operatingCashFlow: 'Net Cash Flow-Operating', capex: 'Capital Expenditures', stock: 'Sale and Purchase of Stock' };

async function nasdaq(ticker) {
  const N = 'https://api.nasdaq.com/api';
  const t = encodeURIComponent(ticker);
  const [target, rating, earnings, fin, divs, info, finY, sum, fc, peg, ins, inst, short] = await Promise.allSettled([
    getJson(`${N}/analyst/${t}/targetprice`),
    getJson(`${N}/analyst/${t}/ratings`),
    getJson(`${N}/analyst/${t}/earnings-date`),
    getJson(`${N}/company/${t}/financials?frequency=2`),
    getJson(`${N}/quote/${t}/dividends?assetclass=stocks`),
    getJson(`${N}/quote/${t}/info?assetclass=stocks`),
    getJson(`${N}/company/${t}/financials?frequency=1`),
    getJson(`${N}/quote/${t}/summary?assetclass=stocks`),
    getJson(`${N}/analyst/${t}/earnings-forecast`),
    getJson(`${N}/analyst/${t}/peg-ratio`),
    getJson(`${N}/company/${t}/insider-trades?limit=20&type=ALL&sortColumn=lastDate&sortOrder=DESC`),
    getJson(`${N}/company/${t}/institutional-holdings?limit=5&type=TOTAL&sortColumn=marketValue&sortOrder=DESC`),
    shortInterest(ticker),
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

  // one row per period: income statement, plus balance sheet and cash flow for the years. Foreign
  // filers (20-F) report no quarters: Nasdaq then answers with one stale quarter from their listing
  // year, so old ones are dropped.
  const table = (tbl, fields) => {
    if (!tbl?.headers || !tbl.rows) return [];
    const cols = Object.keys(tbl.headers).filter(k => k !== 'value1');
    return cols.map(k => {
      const r = { period: usDate(tbl.headers[k]) };
      for (const [f, label] of Object.entries(fields)) {
        const v = usd(tbl.rows.find(x => x.value1 === label)?.[k]);
        r[f] = v == null ? null : v * 1000;
      }
      return r;
    }).filter(r => r.period);
  };
  const statements = (d, parts) => {
    const by = new Map();
    for (const [tbl, fields] of parts(d ?? {})) for (const r of table(tbl, fields)) by.set(r.period, { ...by.get(r.period), ...r });
    const out = [...by.values()].filter(r => r.revenue != null).sort((a, b) => a.period.localeCompare(b.period));
    return out.length ? out : null;
  };
  const recent = days => q => Date.now() - Date.parse(q.period) < days * 864e5;
  const quarterly = statements(ok(fin), d => [[d.incomeStatementTable, INCOME]])?.filter(recent(2 * 366)) || null;
  const years = statements(ok(finY), d => [[d.incomeStatementTable, INCOME], [d.balanceSheetTable, BALANCE], [d.cashFlowTable, CASH]])
    ?.filter(recent(6 * 366)) || null;

  // market value, 52 weeks and volume in USD, the EPS consensus per fiscal year, PEG
  const sd = ok(sum)?.summaryData ?? {};
  const [hi52, lo52] = String(sd.FiftTwoWeekHighLow?.value ?? '').split('/').map(usd);
  const market = { marketCap: usd(sd.MarketCap?.value), high52: hi52 ?? null, low52: lo52 ?? null,
                   volume: usd(sd.ShareVolume?.value), avgVolume: usd(sd.AverageVolume?.value),
                   industry: sd.Industry?.value ?? null, exchange: sd.Exchange?.value ?? null };
  const epsForecast = (ok(fc)?.yearlyForecast?.rows ?? []).map(r => ({
    year: String(r.fiscalEnd ?? '').slice(-4), eps: Number(r.consensusEPSForecast), analysts: Number(r.noOfEstimates) || null,
  })).filter(r => /^\d{4}$/.test(r.year) && Number.isFinite(r.eps));
  const pg = ok(peg);
  const pegRatio = pg?.pegr?.pegValue != null ? {
    value: pg.pegr.pegValue,                                         // P/E on the next 12 months / expected growth
    growth: (pg.gr?.peGrowthChart ?? []).filter(x => x.z === 'Growth').map(x => ({ year: String(x.x), pct: x.y })),
  } : null;

  // insiders: trades in 3 and 12 months, and the latest ones ("Automatic Sell" = a pre-set trading plan)
  const it = ok(ins);
  const cell = (block, label, col) => usd(block?.rows?.find(r => r.insiderTrade === label)?.[col]);
  const span = col => ({ buys: cell(it.numberOfTrades, 'Number of Open Market Buys', col) ?? 0, sells: cell(it.numberOfTrades, 'Number of Sells', col) ?? 0,
                         bought: cell(it.numberOfSharesTraded, 'Number of Shares Bought', col) ?? 0, sold: cell(it.numberOfSharesTraded, 'Number of Shares Sold', col) ?? 0 });
  const insiders = it?.numberOfTrades ? {
    m3: span('months3'), m12: span('months12'),
    recent: (it.transactionTable?.table?.rows ?? []).map(r => ({ name: r.insider, relation: r.relation, date: usDate(r.lastDate),
      type: r.transactionType, shares: usd(r.sharesTraded), price: usd(r.lastPrice) })),
  } : null;

  // institutions, from their quarterly 13F filings
  const ih = ok(inst), pos = (block, label) => ih?.[block]?.rows?.find(r => r.positions === label);
  const holders = (block, label) => usd(pos(block, label)?.holders);
  const top = ih?.holdingsTransactions?.table?.rows ?? [];
  const institutions = ih?.ownershipSummary ? {
    pct: parseFloat(ih.ownershipSummary.SharesOutstandingPCT?.value) || null,
    holders: holders('activePositions', 'Total Institutional Shares'), shares: usd(pos('activePositions', 'Total Institutional Shares')?.shares),
    increased: holders('activePositions', 'Increased Positions'), decreased: holders('activePositions', 'Decreased Positions'),
    newHolders: holders('newSoldOutPositions', 'New Positions'), soldOut: holders('newSoldOutPositions', 'Sold Out Positions'),
    asOf: top.map(r => usDate(r.date)).filter(Boolean).sort().at(-1) ?? null,
    top: top.map(r => ({ name: r.ownerName, shares: usd(r.sharesHeld), changePct: parseFloat(r.sharesChangePCT) || 0, date: usDate(r.date) })),
  } : null;

  const rows = ok(divs)?.dividends?.rows ?? [];
  const dividends = rows.slice(0, 8).map(r => ({
    exDate: usDate(r.exOrEffDate), payDate: usDate(r.paymentDate), amount: usd(r.amount), currency: 'USD',
  })).filter(r => r.exDate && r.amount != null);

  return { ticker, price, analysts, earningsDate, quarterly: quarterly?.length ? quarterly : null,
           years: years?.length ? years : null, market, epsForecast, peg: pegRatio, dividends,
           insiders, institutions, shortInterest: short.status === 'fulfilled' ? short.value : null };
}

/** The company behind a US ticker: "SE" -> "Sea Limited", for a search that only knows names. */
export async function tickerName(ticker) {
  if (!/^[A-Z]{1,5}([.-][A-Z])?$/.test(ticker)) return null;
  try {
    const d = (await getJson(`https://api.nasdaq.com/api/quote/${encodeURIComponent(ticker)}/info?assetclass=stocks`)).data;
    if (!d?.companyName) return null;
    // the share class Nasdaq names apart comes off first: "... Class A Limited Voting Shares" (BN)
    const type = d.stockType?.toLowerCase();
    const name = type && d.companyName.toLowerCase().endsWith(type) ? d.companyName.slice(0, -type.length) : d.companyName;
    return name
      .replace(/\b(American Depositary Shares?|New York Registry Shares|Common Stock|Class [A-C]|Ordinary Shares?|each representing.*$)\b/gi, ' ')
      .replace(/[,.]?\s*\b(Inc|Corp|Corporation|Ltd|plc|N\.V|S\.A|Holdings?)\b\.?/gi, ' ')
      .replace(/[,\s]+$/, '').replace(/\s+/g, ' ').trim() || null;
  } catch { return null; }
}

// onvista answers in German
const SECTOR = { 'Informationstechnologie': 'Technology', 'Technologie': 'Technology', 'Konsumgüter': 'Consumer goods',
  'Transport / Verkehrssektor': 'Transport',
  'Basiskonsumgüter': 'Consumer staples', 'Gesundheitswesen': 'Health care', 'Finanzen': 'Financials',
  'Finanzdienstleistungen': 'Financials', 'Industrie': 'Industrials', 'Energie': 'Energy', 'Versorger': 'Utilities',
  'Rohstoffe': 'Materials', 'Grundstoffe': 'Materials', 'Immobilien': 'Real estate', 'Telekommunikation': 'Telecommunications',
  'Kommunikationsdienste': 'Communication services', 'Dienstleistungen': 'Services', 'Transport': 'Transport',
  'Handel': 'Retail', 'Einzelhandel': 'Retail', 'Medien': 'Media' };
const COUNTRY = { 'USA': 'USA', 'Vereinigte Staaten': 'USA', 'Großbritannien': 'United Kingdom', 'Kanada': 'Canada',
  'Niederlande': 'Netherlands', 'Deutschland': 'Germany', 'Österreich': 'Austria', 'Frankreich': 'France',
  'Schweiz': 'Switzerland', 'Irland': 'Ireland', 'Spanien': 'Spain', 'Italien': 'Italy', 'Dänemark': 'Denmark',
  'Schweden': 'Sweden', 'Norwegen': 'Norway', 'Finnland': 'Finland', 'Belgien': 'Belgium', 'Luxemburg': 'Luxembourg',
  'Japan': 'Japan', 'China': 'China', 'Taiwan': 'Taiwan', 'Südkorea': 'South Korea', 'Indien': 'India',
  'Australien': 'Australia', 'Brasilien': 'Brazil', 'Israel': 'Israel', 'Jersey': 'Jersey', 'Bermuda': 'Bermuda',
  'Singapur': 'Singapore', 'Hongkong': 'Hong Kong', 'Kaimaninseln': 'Cayman Islands', 'Argentinien': 'Argentina',
  'Mexiko': 'Mexico', 'Indonesien': 'Indonesia', 'Uruguay': 'Uruguay' };
const profiles = new Map();

/** Sector and country, for the allocation bars. Funds and crypto get a type instead. Cached a day. */
export async function profile(key) {
  const hit = profiles.get(key);
  if (hit && Date.now() - hit.at < 24 * 60 * 60 * 1000) return hit.value;
  const ins = await resolve(key);
  let value = { sector: ins.entityType === 'CRYPTO' ? 'Crypto' : 'Funds & ETFs', country: ins.entityType === 'CRYPTO' ? 'Crypto' : 'Funds & ETFs' };
  if (ins.entityType === 'STOCK' && /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(key)) {
    const snap = await getJson(`https://api.onvista.de/api/v1/stocks/ISIN:${key}/snapshot`);
    const sec = snap.company?.branch?.sector?.name, ctry = snap.company?.nameCountry;
    value = { sector: SECTOR[sec] ?? sec ?? 'Unknown', country: COUNTRY[ctry] ?? ctry ?? 'Unknown' };
  }
  profiles.set(key, { at: Date.now(), value });
  return value;
}

export async function analysis(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;

  const ins = await resolve(key);
  const out = { key, name: ins.name, type: ins.entityType, isin: /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(key) ? key : null,
                profile: null, range: null, annual: [], risk: null, us: null, notes: [] };

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
      const s = snap.value, f = s.stocksFigure ?? {};
      // onvista's company value can be far off (Brookfield 687 bn € for 2.45 bn shares at 33 €, Novartis
      // twice): the company's shares at this line's value per share instead
      const perShare = f.marketCapInstrument && f.numSharesInstrument ? f.marketCapInstrument / f.numSharesInstrument : null;
      out.profile = {
        sector: SECTOR[s.company?.branch?.sector?.name] ?? s.company?.branch?.sector?.name ?? null,
        country: COUNTRY[s.company?.nameCountry] ?? s.company?.nameCountry ?? null,
        marketCap: perShare && f.numSharesCompany ? f.numSharesCompany * perShare : f.marketCapCompany ?? null,
        marketCapCurrency: f.isoCurrency ?? null,
        shares: f.numSharesCompany ?? null,
        symbol: s.instrument?.homeSymbol ?? null,
      };
    }
    if (fig.status === 'fulfilled') { out.annual = annual(fig.value); out.risk = risk(fig.value); }
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
