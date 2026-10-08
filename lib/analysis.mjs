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
 *            The snapshot adds the last four years as filed (balance sheet, interest, minorities),
 *            splits and spin-offs, every venue the share trades on, the CEO's pay ratio.
 *   Nasdaq   api.nasdaq.com - US-listed tickers only: US ISINs, and shares from elsewhere that
 *            also trade on a US exchange, by the US ticker OpenFIGI gives for the ISIN - not the
 *            home symbol: "NEO" on Nasdaq is NeoGenomics, not Neo Performance Materials (TSX).
 *   OpenFIGI lib/figi.mjs - ISIN -> US ticker and exchange for shares with a non-US ISIN. No key.
 *   FINRA    api.finra.org - short interest of US-listed shares, twice a month, no key.
 *   Yahoo    lib/yahoo.mjs - free cash flow, buybacks, dividends paid, share count for shares with
 *            a non-US ISIN (US ones have Nasdaq's cash flow); for every share analysts' price targets
 *            (used where Nasdaq has none) and EV/EBITDA: `targets`; analysts' revenue and EPS for this
 *            and next year and quarter, the last quarters against their estimates, the next results
 *            day: `estimates` - and its years in place of onvista's estimates (mergeEstimates).
 *            Unofficial: missing when it fails.
 *   BaFin    lib/bafin.mjs - directors' dealings of German issuers (DE ISINs): `insiders`.
 *   Funds    onvista /funds - costs, size, index, top holdings, countries, sectors, currencies, returns
 *            against the index, payouts: `fund`.
 *
 * Cached in memory for 6 hours. Every block can be missing; the page shows what exists.
 */
import { resolve, closes } from './market.mjs';
import { cashflow, targets, estimates } from './yahoo.mjs';
import { rates } from './rates.mjs';
import { dealings } from './bafin.mjs';
import { usListings } from './figi.mjs';

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

/**
 * onvista figures -> one row per year, estimates flagged. Amounts in EUR. A bank has no EBITDA: its
 * revenue is then the reported turnover (company currency) at onvista's rate - one rate for all years,
 * so the ratio of the two in any year with both gives it.
 */
function annual(fig) {
  const fin = new Map((fig.stocksCnFinancialList?.list ?? []).map(x => [x.label, x]));
  const fun = new Map((fig.stocksCnFundamentalList?.list ?? []).map(x => [x.label, x]));
  const bal = new Map((fig.stocksBalanceSheetList?.list ?? []).map(x => [x.label, x]));
  const labels = [...new Set([...fin.keys(), ...fun.keys()])].sort();
  const derived = f => (f.cnEbitda != null && f.cnEbitdaMa ? f.cnEbitda / (f.cnEbitdaMa / 100) : null);
  const both = labels.map(l => [derived(fin.get(l) ?? {}), bal.get(l)?.turnover]).find(([d, t]) => d > 0 && t > 0);
  const rate = both ? both[0] / both[1] : null;
  return labels.map(label => {
    const f = fin.get(label) ?? {}, u = fun.get(label) ?? {}, t = bal.get(label)?.turnover;
    const revenue = derived(f) ?? (rate && t ? t * rate : null);
    return {
      label: label.replace(/e$/, ''), estimate: label.endsWith('e'),        // '2025', '2026e', or fiscal '24/25'
      revenue, ebitda: f.cnEbitda ?? null, ebit: f.cnEbit ?? null,
      netIncome: revenue != null && f.cnMarginNet != null ? revenue * f.cnMarginNet / 100 : null,
      eps: f.cnEpsAdj ?? null, dps: u.cnDps ?? null, dpsAdj: u.cnDpsAdj ?? null, divYield: u.cnDivYield ?? null, per: u.cnPer ?? null,
      roe: f.cnReturnEquity ?? null, equityRatio: f.cnEquityRatio ?? null, ebitMargin: f.cnEbitMa ?? null,
      cashflow: f.cnCashflow ?? null, pb: u.cnPriceBookvalue ?? null, pcf: u.cnPriceCf ?? null, peg: u.cnPeg ?? null,
      bookPerShare: f.cnEquityShare ?? null,                                  // €, over every share class
      marketCap: u.cnMarketCap ?? f.cnMarketCap ?? null,
      debtEquity: f.cnDebtEquity ?? null,                                     // liabilities ÷ equity, %
      employees: u.employees ?? null, exDividend: u.dateExDividend?.slice(0, 10) ?? null,
    };
  }).filter(r => [r.revenue, r.ebitda, r.eps, r.dps].some(v => v != null));
}

/**
 * onvista's last four reported years as filed (IFRS / US GAAP), in the currency it lists them in -
 * not always the company's own (Brookfield reports in USD, onvista lists CAD). Use them as ratios.
 * netIncome is the shareholders' part (after minority interests); equity the same.
 */
function reported(snap) {
  return (snap.stocksBalanceSheetList?.list ?? []).map(b => ({
    label: b.label, end: b.periodeEnd ?? null, currency: b.isoCurrency ?? null, standard: b.nameBalanceType ?? null,
    revenue: b.turnover ?? null, netIncome: b.incomeAfterMi ?? null, pretax: b.earningBeforeTax ?? null,
    interestPaid: b.paidInterests ?? null, equity: b.shareholdersEquity ?? null, minorities: b.minInterestBal ?? null,
    totalAssets: b.totalAssets ?? null, currentAssets: b.currentAssets ?? null, currentLiabilities: b.currentLiabilities ?? null,
    liabilities: b.liabilities ?? null, cash: b.cashReserve ?? null, dividendsPaid: b.payout ?? null,
    cashflow: b.cashflowNet ?? null, intangibles: b.intangibleAssets ?? null, employees: b.employees ?? null,
  })).filter(r => r.totalAssets || r.revenue);
}

// a fiscal year by its end, as onvista labels it: '2026' for one ending in December, '26/27' for one ending in 2027 earlier
const yy = n => String(n % 100).padStart(2, '0');
export const fyLabel = end => (end.slice(5, 7) === '12' ? end.slice(0, 4) : `${yy(end.slice(0, 4) - 1)}/${yy(+end.slice(0, 4))}`);
const endOf = l => (/^\d{4}$/.test(l) ? `${l}-12-31` : /^\d{2}\/\d{2}$/.test(l) ? `20${l.slice(3)}-06-30` : null);

/**
 * A year counts as reported once it is filed, not once it has ended: onvista lists On Holding's 2026-2028
 * without its "e", so on 1 January an estimate would turn into a result. Filed: onvista has it as filed
 * (`filed` labels), results for a period at or after its end are out (`through`: Yahoo's last quarter, Nasdaq's
 * last year), or it ended over four months ago - when most companies must have filed. Else: an estimate.
 */
export function markFiled(annual, { filed = [], through = null }, today) {
  const done = new Set(filed);
  for (const r of annual) {
    const end = r.end ?? endOf(r.label);
    if (r.estimate || !end) continue;
    if (!(done.has(r.label) || (through && end <= through) || Date.parse(today) - Date.parse(end) > 122 * 864e5)) r.estimate = true;
  }
  return annual;
}

/**
 * Analysts' years from Yahoo in place of onvista's estimates, in euros at the ECB rate (est.rate, per 1 €):
 * revenue - onvista has none ahead - and EPS, with how many analysts. One source per figure, never a year from
 * each: where Yahoo has EPS, onvista's EPS of the years it lacks goes too (and its PEG, made from it).
 * Dividends stay onvista's. A year Yahoo has and onvista not gets a row.
 *   est  { rate, years: [{ label, end, eps, epsAnalysts, revenue, revenueAnalysts }] } (company's currency)
 */
export function mergeEstimates(annual, est) {
  if (!est?.rate || !est.years?.length) return annual;
  const eur = v => (v == null ? null : v / est.rate);
  const hasEps = est.years.some(y => y.eps != null), hasRev = est.years.some(y => y.revenue != null);
  const rows = annual.map(r => ({ ...r }));
  for (const y of est.years) {
    if (!rows.some(r => r.label === y.label)) rows.push({ label: y.label, end: y.end, estimate: true, revenue: null, ebitda: null, ebit: null,
      netIncome: null, eps: null, dps: null, dpsAdj: null, divYield: null, per: null, peg: null });
  }
  for (const r of rows.filter(x => x.estimate)) {
    const y = est.years.find(x => x.label === r.label);
    if (hasEps) Object.assign(r, { eps: eur(y?.eps), epsAnalysts: y?.epsAnalysts ?? null, peg: null });
    if (hasRev) Object.assign(r, { revenue: eur(y?.revenue), revenueAnalysts: y?.revenueAnalysts ?? null });
    if (y) Object.assign(r, { end: y.end, source: 'Yahoo' });
  }
  return rows.sort((a, b) => (a.end ?? endOf(a.label) ?? '').localeCompare(b.end ?? endOf(b.label) ?? ''));
}

/** Splits and spin-offs, newest first: a factor that is not a whole split ratio (1,2439) is a spin-off. */
const splitsOf = snap => (snap.stocksSplitList?.list ?? []).map(s => ({ date: s.dateSplit?.slice(0, 10), factor: s.factor }))
  .filter(s => s.date && s.factor > 0);

/** Every venue onvista lists for the share: where it trades, in which currency, its last price and 4-week volume. */
const listingsOf = snap => (snap.quoteList?.list ?? []).map(q => ({
  venue: q.market?.name ?? null, exchange: q.market?.codeExchange ?? null, country: q.market?.isoCountry ?? null,
  currency: q.isoCurrency ?? null, last: q.last ?? null, at: q.datetimeLast ?? null, volume4w: q.volume4Weeks ?? null,
})).filter(q => q.venue);
const UNIT = { GBp: 'GBP', GBX: 'GBP', ZAc: 'ZAR', ILA: 'ILS' };        // prices in pence or cents: their currency
/**
 * Where most of its shares trade (4-week volume), and so the currency its price is made in: On on the NYSE
 * in dollars though Swiss, Games Workshop in London in pounds, SAP on Xetra in euros. Every share also trades
 * in Germany in euros, so a company from elsewhere counts by its venues outside Germany; OTC quotes are not
 * a listing (Neo's OTC volume beats the one Toronto venue onvista has). No volumes: the first venue.
 */
export function mainListing(listings, isin) {
  const list = (listings ?? []).filter(l => l.currency && !/OTC/i.test(l.venue) && l.exchange !== 'PNK');
  const abroad = isin?.startsWith('DE') ? [] : list.filter(l => l.country !== 'DE');
  const pick = abroad.length ? abroad : list;
  const top = pick.filter(l => l.volume4w > 0).sort((a, b) => b.volume4w - a.volume4w)[0] ?? pick[0];
  return top ? { venue: top.venue, currency: UNIT[top.currency] ?? top.currency } : null;
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
                 ebit: 'Earnings Before Interest and Tax', interestExpense: 'Interest Expense', pretax: 'Earnings Before Tax',
                 netIncome: 'Net Income' };
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
    year: String(r.fiscalEnd ?? '').slice(-4), eps: Number(r.consensusEPSForecast), analysts: Number(r.noOfEstimates) || null, source: 'Nasdaq',
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
    const plain = name.replace(/\b(American Depositary Shares?|New York Registry Shares|Common Stock|Class [A-C]|Ordinary Shares?|each representing.*$)\b/gi, ' ');
    const tidy = s => s.replace(/[,\s]+$/, '').replace(/\s+/g, ' ').trim() || null;
    const bare = tidy(plain.replace(/[,.]?\s*\b(Inc|Corp|Corporation|Ltd|plc|N\.V|S\.A|Holdings?)\b\.?/gi, ' '));
    // "On Holding AG" without "Holding" is "On AG": no word left to match a name by, so it stays
    return bare && /\p{L}{3,}/u.test(bare) ? bare : tidy(plain.replace(/[,.]?\s*\b(Inc|Corp|Corporation|Ltd|plc|N\.V|S\.A)\b\.?/gi, ' '));
  } catch { return null; }
}

// onvista answers in German. A company's sector comes from its industry first: onvista's own sectors put online
// shops with chip makers (Amazon, Bike24: "Internetkommerz" under "Informationstechnologie") and planes under
// transport. Each industry goes to the usual sector (GICS's eleven) most of its companies have; one that is a
// mix ("Sonstige Branchen") keeps onvista's sector.
const INDUSTRY = Object.fromEntries(Object.entries({
  'Technology': ['Computer-Hardware', 'Elektrotechnologie', 'Halbleiterindustrie', 'IT-Dienstleistungen', 'Internetservice',
    'IT-Software (Telekommunikation und Internet)', 'Netzwerktechnik und -systeme', 'Softwareservice / -dienstleistung',
    'Sonstige Technologie', 'Spezialsoftware', 'Standardsoftware'],
  'Communication': ['Broadcasting (TV und Radio)', 'Entertainment / Dienstleistungen', 'Medien', 'Printmedien (Zeitungen und Magazine)',
    'Telekomdienstleister', 'Telekommunikationsausrüster', 'Werbung'],
  'Consumer': ['Automobilproduktion', 'Automobilzulieferer', 'Bekleidungsartikel', 'Einzelhandel', 'Internetkommerz',
    'Langlebige Haushaltsprodukte', 'Restaurants und Foodvertrieb', 'Sonstige Handel', 'Sonstige Konsumgüter', 'Sport / Glücksspiel',
    'Sportartikel', 'Textilindustrie', 'Touristik und Freizeit', 'Unterhaltungselektronik'],
  'Consumer staples': ['Drogerie und Kosmetikgüter', 'Getränke / Tabak', 'Kaufhäuser', 'Nahrungsmittel'],
  'Health care': ['Biotechnologie', 'Gesundheitsdienstleistungen', 'Medizin', 'Medizinische Geräte', 'Pharma', 'Pharmahandel'],
  'Financials': ['Banken', 'Finanzdienstleistungen', 'Holdings', 'Investment', 'Versicherungen'],
  'Industrials': ['Autovermietungen', 'Bauhauptgewerbe', 'Baumaterial und -komponenten', 'Dienstleistungen', 'Diversifizierte Gewerbe',
    'Eisenbahn und Straße', 'Elektroausstattung und Vertrieb', 'Entsorgung / Umwelttechnologie / -dienstleistung',
    'Erneuerbare Energieanlagen', 'Fluggesellschaften', 'Gütertransport', 'Luft- und Raumfahrtindustrie', 'Maschinenbau',
    'Mischkonzerne', 'Schifffahrt', 'Spezialmaschinenbau'],
  'Energy': ['Exploration', 'Öl und Gas'],
  'Materials': ['Chemie', 'Edelmetalle', 'Eisen / Stahlindustrie', 'Kunststoffe', 'Metallverarbeitung', 'Mine bzw. Minengesellschaft',
    'Papierindustrie', 'Rohstoffe', 'Spezialchemie'],
  'Utilities': ['Energieversorger', 'Sonstige Versorger'],
  'Real estate': ['Immobilien'],
}).flatMap(([sector, industries]) => industries.map(i => [i, sector])));
// onvista's sectors - for an industry not above - and the sector names in funds' breakdowns
const SECTOR = { 'Informationstechnologie': 'Technology', 'Technologie': 'Technology', 'Software': 'Technology', 'IT/Telekommunikation': 'Technology',
  'Telekommunikation': 'Communication', 'Telekomdienste': 'Communication', 'Kommunikationsdienste': 'Communication',
  'Medien': 'Communication', 'Medien/Entertainment/ Freizeit': 'Communication',
  'Konsumgüter': 'Consumer', 'Konsumgüter zyklisch': 'Consumer', 'Kraftfahrzeugindustrie': 'Consumer', 'Handel': 'Consumer', 'Einzelhandel': 'Consumer',
  'Basiskonsumgüter': 'Consumer staples', 'Gesundheitswesen': 'Health care', 'Chemie / Pharma / Gesundheit': 'Health care',
  'Finanzen': 'Financials', 'Finanzdienstleistungen': 'Financials', 'Finanzsektor': 'Financials',
  'Industrie': 'Industrials', 'Bauindustrie': 'Industrials', 'Transport / Verkehrssektor': 'Industrials', 'Transport': 'Industrials',
  'Dienstleistungen': 'Industrials', 'Energie': 'Energy', 'Energie / Rohstoffe': 'Energy', 'Rohstoffe': 'Materials', 'Grundstoffe': 'Materials',
  'Versorger': 'Utilities', 'Immobilien': 'Real estate', 'Diverse': 'Diversified', 'diverse Branchen': 'Diversified', 'Barmittel': 'Cash' };
/** onvista's company -> its sector: by industry, else onvista's sector. "Internetkommerz" (Amazon) -> Consumer */
export const sectorOf = c => INDUSTRY[c?.branch?.name] ?? SECTOR[c?.branch?.sector?.name] ?? c?.branch?.sector?.name ?? null;
const COUNTRY = { 'USA': 'USA', 'Vereinigte Staaten': 'USA', 'Großbritannien': 'United Kingdom', 'Kanada': 'Canada',
  'Niederlande': 'Netherlands', 'Deutschland': 'Germany', 'Österreich': 'Austria', 'Frankreich': 'France',
  'Schweiz': 'Switzerland', 'Irland': 'Ireland', 'Spanien': 'Spain', 'Italien': 'Italy', 'Dänemark': 'Denmark',
  'Schweden': 'Sweden', 'Norwegen': 'Norway', 'Finnland': 'Finland', 'Belgien': 'Belgium', 'Luxemburg': 'Luxembourg',
  'Japan': 'Japan', 'China': 'China', 'Taiwan': 'Taiwan', 'Südkorea': 'South Korea', 'Indien': 'India',
  'Australien': 'Australia', 'Brasilien': 'Brazil', 'Israel': 'Israel', 'Jersey': 'Jersey', 'Bermuda': 'Bermuda',
  'Singapur': 'Singapore', 'Hongkong': 'Hong Kong', 'Kaimaninseln': 'Cayman Islands', 'Argentinien': 'Argentina',
  'Mexiko': 'Mexico', 'Indonesien': 'Indonesia', 'Uruguay': 'Uruguay', 'Portugal': 'Portugal', 'Polen': 'Poland',
  'Griechenland': 'Greece', 'Tschechien': 'Czech Republic', 'Ungarn': 'Hungary', 'Türkei': 'Turkey', 'Südafrika': 'South Africa',
  'Neuseeland': 'New Zealand', 'Saudi-Arabien': 'Saudi Arabia', 'Vereinigte Arabische Emirate': 'United Arab Emirates',
  'Katar': 'Qatar', 'Thailand': 'Thailand', 'Malaysia': 'Malaysia', 'Philippinen': 'Philippines', 'Chile': 'Chile' };
const CURRENCY = { 'Euro': 'EUR', 'US-Dollar': 'USD', 'Pfund Sterling': 'GBP', 'Schweizer Franken': 'CHF', 'Japanischer Yen': 'JPY',
  'Kanadischer Dollar': 'CAD', 'Australischer Dollar': 'AUD', 'Schwedische Krone': 'SEK', 'Dänische Kronen': 'DKK', 'Dänische Krone': 'DKK',
  'Norwegische Krone': 'NOK', 'Hongkong-Dollar': 'HKD' };
const profiles = new Map();

/** Sector, country and the currency of its main listing, for the allocation bars. Funds and crypto get a type instead. Cached a day. */
export async function profile(key) {
  const hit = profiles.get(key);
  if (hit && Date.now() - hit.at < 24 * 60 * 60 * 1000) return hit.value;
  const ins = await resolve(key);
  let value = { sector: ins.entityType === 'CRYPTO' ? 'Crypto' : 'Funds & ETFs', country: ins.entityType === 'CRYPTO' ? 'Crypto' : 'Funds & ETFs', currency: null };
  if (ins.entityType === 'STOCK' && /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(key)) {
    const snap = await getJson(`https://api.onvista.de/api/v1/stocks/ISIN:${key}/snapshot`);
    const ctry = snap.company?.nameCountry;
    value = { sector: sectorOf(snap.company) ?? 'Unknown', country: COUNTRY[ctry] ?? ctry ?? 'Unknown', currency: mainListing(listingsOf(snap), key)?.currency ?? null };
  }
  profiles.set(key, { at: Date.now(), value });
  return value;
}

/**
 * A fund or ETF from onvista: costs, size, index, how it holds it, what it holds (top 10, countries, sectors,
 * currencies - as the issuer reports them, onvista's date in `asOf`), returns against its index, payouts.
 * Percentages as onvista gives them (14,06 = 14,06 %).
 */
async function fund(isin) {
  const B = 'https://api.onvista.de/api/v1/funds';
  const [s, bd] = await Promise.all([getJson(`${B}/ISIN:${isin}/snapshot`), getJson(`${B}/ISIN:${isin}/breakdowns`).catch(() => ({}))]);
  const pay = await getJson(`${B}/${s.instrument?.entityValue}/earning`).catch(() => null);
  const b = s.fundsBaseData ?? {}, det = s.fundsDetails ?? {};
  const parts = (x, map) => (x?.list ?? []).filter(r => r.investmentPct > 0)
    .map(r => ({ name: map?.[r.nameBreakdown] ?? r.nameBreakdown, pct: r.investmentPct })).sort((a, c) => c.pct - a.pct);
  const by = (list, k) => Object.fromEntries((list ?? []).filter(r => r[k] != null).map(r => [r.timeSpan, r[k]]));
  const perf = by(s.fundsPerformanceList?.list, 'performanceTimeSpanPct');
  const risk = Object.fromEntries((s.fundsRiskList?.list ?? []).map(r => [r.timeSpan, { volatility: r.volatility ?? null, maxDrawdown: r.maxDrawdown ?? null }]));
  const holdings = (bd.fundsHoldingList ?? s.fundsHoldingList)?.list ?? [];
  return {
    issuer: s.fundsIssuer?.nameGroupIssuer ?? s.fundsIssuer?.name ?? null,
    index: s.fundsBenchmarkList?.list?.[0]?.instrument?.name ?? null,
    equity: det.nameTypeFund === 'Aktienfonds',
    focus: det.nameInvestmentFocus ?? null, region: det.fundsInvestmentRegion?.name ?? null,
    replication: { 1: 'swap', 2: 'full', 3: 'sampling' }[det.fundsTypeReplication?.id] ?? det.fundsTypeReplication?.name ?? null,
    use: { 1: 'accumulating', 2: 'distributing' }[det.fundsTypeCapitalisation?.id] ?? null,
    ter: b.ongoingCharges ?? b.managementFeeExPostMifid ?? null,
    size: b.volumeFundEuro ?? null, sizeDate: b.dateVolume?.slice(0, 10) ?? null,
    launched: b.dateEmission?.slice(0, 10) ?? null, domicile: COUNTRY[b.nameCountry] ?? b.nameCountry ?? null, currency: b.isoCurrencyFund ?? null,
    riskClass: s.fundsEvaluation?.riskClass ?? null, morningstar: Number(s.fundsEvaluation?.morningstarRating) || null,
    holdings: holdings.map(h => ({ name: h.instrument?.name, isin: h.instrument?.isin || null, pct: h.investmentPct })),
    countries: parts(bd.countryBreakdown, COUNTRY), sectors: parts(bd.branchBreakdown ?? s.branchFundsBreakdownList, SECTOR),
    currencies: parts(bd.currencyBreakdown, CURRENCY), assets: parts(bd.instrumentBreakdown),
    asOf: (bd.fundsHoldingList ?? s.fundsHoldingList)?.dateMaintenance?.slice(0, 10) ?? bd.countryBreakdown?.dateMaintenance?.slice(0, 10) ?? null,
    returns: { y1: perf['1Y'] ?? null, y3: perf['3Y'] ?? null, y5: perf['5Y'] ?? null, y10: perf['10Y'] ?? null, since: perf.SE ?? null,
               years: (s.fundsPerformanceList?.list ?? []).filter(r => /^\d+PA$/.test(r.timeSpan) && r.performanceTimeSpanPct != null)
                 .map(r => ({ year: r.nameTimeSpan, pct: r.performanceTimeSpanPct })) },
    // the fund's return less its index's, in % over the span: what costs and tracking took
    vsIndex: by(s.fundsFigureBenchmarkList?.list, 'relativeReturnPct'),
    risk: { y1: risk['1Y'] ?? null, y3: risk['3Y'] ?? null, y5: risk['5Y'] ?? null },
    payouts: (pay?.list ?? []).filter(e => e.valueEarning > 0)
      .map(e => ({ date: e.dateEarning.slice(0, 10), amount: e.valueEarningAdjusted ?? e.valueEarning, currency: e.isoCurrency }))
      .sort((a, c) => a.date.localeCompare(c.date)),
  };
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

  if (ins.entityType === 'FUND' && out.isin) {
    out.fund = await fund(key).catch(() => null);
    if (!out.fund) out.notes.push('Fund data unavailable right now.');
  } else if (ins.entityType !== 'STOCK' || !out.isin) {
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
        sector: sectorOf(s.company),
        country: COUNTRY[s.company?.nameCountry] ?? s.company?.nameCountry ?? null,
        marketCap: perShare && f.numSharesCompany ? f.numSharesCompany * perShare : f.marketCapCompany ?? null,
        marketCapCurrency: f.isoCurrency ?? null,
        shares: f.numSharesCompany ?? null,
        symbol: s.instrument?.homeSymbol ?? null, wkn: s.instrument?.wkn ?? null,
        // banks and insurers: free cash flow, current ratio and debt checks do not fit them
        kind: { Bank: 'bank', Versicherung: 'insurer' }[s.stocksBalanceSheetList?.list?.at(-1)?.nameCompanyType] ?? null,
        ceo: s.sustainabilityData?.societyGroup?.ceoEmployeeRatioCEO
          ? { name: s.sustainabilityData.societyGroup.ceoEmployeeRatioCEO, payRatio: s.sustainabilityData.societyGroup.ceoEmployeeRatioValue ?? null }
          : null,
      };
      out.reported = reported(s); out.splits = splitsOf(s); out.listings = listingsOf(s);
      const main = mainListing(out.listings, out.isin);
      Object.assign(out.profile, { currency: main?.currency ?? null, venue: main?.venue ?? null });
      out.dataAsOf = { price: s.quote?.datetimeLast ?? null, figures: f.datetimeCalculation ?? null };
    }
    if (fig.status === 'fulfilled') { out.annual = annual(fig.value); out.risk = risk(fig.value); }
    else out.notes.push('Financials unavailable right now.');

    // Nasdaq: US ISINs, and shares from elsewhere that also trade on a US exchange (Brookfield on the NYSE,
    // On on the NYSE): their US ticker by ISIN (OpenFIGI). Not OTC - there Nasdaq would answer for another company.
    const today = new Date().toISOString().slice(0, 10);
    const [ticker, cf, dd, tg, est, fx] = await Promise.all([
      key.startsWith('US') ? out.profile?.symbol : usListings([key]).then(u => u[key]?.ticker ?? null, () => null),
      key.startsWith('US') ? null : cashflow(key),
      key.startsWith('DE') ? dealings(key, today) : null,
      targets(key), estimates(key), rates().catch(() => null),
    ]);
    out.cashflow = cf; out.insiders = dd; out.targets = tg;
    if (ticker) {
      try {
        out.us = await nasdaq(ticker);
        // a share listed at home keeps onvista's financials: Nasdaq's net income for Brookfield is the
        // consolidated one (3,2 bn $ incl. minority partners, 1,3 bn $ to shareholders). Its insiders file
        // at home, not on Form 4, so Nasdaq's "no insider trades" would say nothing.
        if (!key.startsWith('US')) out.us = { ...out.us, years: null, quarterly: null, insiders: null, listedAs: ticker };
      } catch { out.notes.push('Analyst data unavailable right now.'); }
    } else {
      out.notes.push(`Quarterly figures: shares listed in the US only${tg?.target ? '; analysts\' targets from Yahoo' : ''}.`);
    }

    // which years are reported - filed, not just ended - then the analysts' years from Yahoo in place of onvista's.
    // An ADR's estimates count only in dollars: in its home currency they are per home share, not per ADR
    const through = [...(est?.reported ?? []).map(q => q.end), ...(out.us?.years ?? []).map(y => y.period)].sort().at(-1) ?? null;
    markFiled(out.annual, { filed: (out.reported ?? []).map(r => r.label), through }, today);
    if (est && (!key.startsWith('US') || est.currency === 'USD')) {
      const rate = est.currency === 'GBp' ? fx?.fx?.GBP * 100 : fx?.fx?.[est.currency];
      out.estimates = { source: 'Yahoo', ...est, rate: rate || null, years: est.years.map(y => ({ label: fyLabel(y.end), ...y })) };
      out.annual = mergeEstimates(out.annual, out.estimates);
      // US-listed: Yahoo's dollars a share for the years ahead, in place of Nasdaq's - one source for P/E, outlook, Lynch
      const ahead = est.currency === 'USD' ? est.years.filter(y => y.eps != null) : [];
      if (out.us && ahead.length) out.us.epsForecast = ahead.map(y => ({ year: y.end.slice(0, 4), eps: y.eps, analysts: y.epsAnalysts, source: 'Yahoo' }));
    }
  }
  cache.set(key, { at: Date.now(), value: out });
  return out;
}
