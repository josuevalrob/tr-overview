#!/usr/bin/env node
/**
 * tr-overview as an MCP server, so an agent can read and work with the depot.
 *
 *   claude mcp add tr-overview -- node /path/to/tr-overview/mcp.mjs
 *
 * stdio, JSON-RPC 2.0, one message per line - written by hand to keep the project free of
 * dependencies. Same data folder and the same code (lib/app.mjs) as the web page; it does
 * not need the web server running. Amounts are euros unless a field says otherwise.
 * stdout is the protocol channel: anything else goes to stderr.
 */
import path from 'node:path';
import fs from 'node:fs';
import { createApp, berlinToday } from './lib/app.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const app = createApp({ dataDir: process.env.DATA_DIR || path.join(HERE, 'data') });
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')).version;
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

// ---------------------------------------------------------------- helpers

const e = c => (c == null ? null : Math.round(c) / 100);                 // cents -> euros
const r2 = v => (v == null ? null : Math.round(v * 100) / 100);
const settingsOf = a => ({ joint: !!a.joint, church: Number(a.church) || 0 });

/**
 * "Uber", "meta", "US0231351067", "btc" -> the instrument key. Holdings and followed stocks
 * first (by ISIN or name), then anything ever traded, then onvista's search.
 */
async function resolveStock(text) {
  const t = String(text || '').trim();
  if (!t) throw new Error('say which stock: a name or an ISIN');
  const rows = app.rows();
  const known = new Map();
  for (const r of rows) if (r.key && (r.type === 'BUY' || r.type === 'SELL')) known.set(r.key, r.name || r.key);
  for (const w of app.watchRaw()) known.set(w.key, w.name);
  const up = t.toUpperCase(), word = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
  for (const [k, n] of known) if (k.toUpperCase() === up) return { key: k, name: n };
  for (const [k, n] of known) if (word.test(n)) return { key: k, name: n };    // at a word start: "meta" finds Meta Platforms, "ron" not Micron
  const hit = (await app.search(t))[0];
  if (!hit) throw new Error(`nothing found for "${t}"`);
  return { key: hit.key, name: hit.name };
}

const position = (p, profiles) => ({
  name: p.name, key: p.key, type: p.assetClass || null,
  sector: profiles?.[p.key]?.sector ?? null, country: profiles?.[p.key]?.country ?? null,
  shares: p.shares, price: p.last ?? null, price_time: p.at ?? null, venue: p.venue ?? null,
  today_pct: r2(p.dayPct), today_eur: e(p.day), value: e(p.value), paid: e(p.cost),
  gain_eur: e(p.gain), gain_pct: r2(p.gainPct), weight_pct: r2(p.weight),
  ...(p.fromPrice != null ? { gain_split: { currency: p.home ?? null, from_price_eur: e(p.fromPrice), from_currency_eur: e(p.fromCurrency),
    ...(p.fxMove != null ? { currency_vs_eur_since_bought_pct: r2(p.fxMove), rate_paid_at: Number(p.fxThen.toFixed(4)), rate_now: p.fxNow, rate_date: p.fxAsOf } : {}) } } : {}),
  ...(p.error ? { error: p.error } : {}),
});

const RANGES = { '1W': 7, '1M': 31, 'YTD': 'ytd', '1Y': 366, 'ALL': null };

// company numbers: last 4 quarters, change on the same quarter a year before (amounts %, rates points)
const kpiOut = t => t && ({
  company: t.company, currency: t.currency, latest: t.latest, update_due: t.due,
  numbers: t.rows.map(r => ({ id: r.id, label: r.label, unit: r.unit, help: r.help, judged_by: r.measure,
    your_line: r.line, tone: r.tone,
    quarters: r.cells.map(c => ({ period: c.period, value: c.value, change: c.change == null ? null : r2(c.change), change_unit: r.unit === '%' ? 'points' : '%' })) })),
});

// money-weighted (XIRR), so money paid in last week weighs a week; null under a year of data
const perYear = a => ({
  everything_pct: r2(a?.all.pct), stocks_and_crypto_pct: r2(a?.stocks.pct),
  since: a?.all.since ?? null, method: 'money-weighted (XIRR): counts how long each euro was in',
});

// ---------------------------------------------------------------- tools

const TOOLS = [
  {
    name: 'overview',
    description: 'The depot right now: stocks + crypto value, what was paid, gain since bought, today\'s move, cash, total at Trade Republic, money paid in, return per year (everything and stocks + crypto), and how fresh the transaction export is. Start here.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const d = await app.summary({});
      if (d.empty) return { empty: true, hint: 'No Trade Republic export yet. Use import_export with the path of a CSV from Trade Republic → Statements → Transaction export.' };
      const stale = Math.round((Date.parse(d.today) - Date.parse(d.asOf)) / 864e5);
      return {
        today: d.today, transactions_until: d.asOf, export_age_days: stale,
        ...(stale > 10 ? { warning: `The export ends ${d.asOf}: trades, deposits and interest since then are missing.` } : {}),
        stocks_and_crypto: { value: e(d.value), paid: e(d.cost), gain_eur: e(d.value - d.cost),
                             gain_pct: r2(d.cost ? (d.value / d.cost - 1) * 100 : null),
                             gain_from_currency_eur: e(d.positions.reduce((s, p) => s + (p.fromCurrency ?? 0), 0)),
                             today_eur: e(d.day), today_pct: r2(d.dayPct) },
        cash: e(d.cash), total: e(d.cash + d.value), paid_in: e(d.paidIn),
        return_per_year: perYear(d.annual),
        positions: d.positions.length,
        largest: d.positions.slice(0, 3).map(p => ({ name: p.name, weight_pct: r2(p.weight) })),
        errors: d.errors,
      };
    },
  },
  {
    name: 'positions',
    description: 'Every open position at the live LS Exchange price (EUR): shares, price, today\'s move, its contribution to the depot\'s move today (percentage points, adding up to the total), value, paid, gain since bought (€ and %), weight, sector, country. gain_split: the gain in two parts that add up to it - the price in its own currency, and that currency against the euro (ECB rate on each buy day vs the latest; rates per 1 €). Euro shares and crypto: all price.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const d = await app.summary({});
      if (d.empty) return { positions: [] };
      // contribution to today's return: euro move / yesterday's value of the whole depot
      const base = d.positions.reduce((s, p) => s + (p.day != null ? p.value - p.day : 0), 0);
      return { as_of: d.positions.map(p => p.at).filter(Boolean).sort().pop() ?? null,
               depot_today_pct: r2(d.dayPct), depot_today_eur: e(d.day),
               positions: d.positions.map(p => ({ ...position(p, d.profiles),
                 today_contribution_pp: p.day != null && base ? r2((p.day / base) * 100 * 100) / 100 : null })) };
    },
  },
  {
    name: 'performance',
    description: 'Result of stocks + crypto over a range: price moves only (buys and sells left out, realised gains included), in € and as % of the most that was invested in the range. Optionally the daily values.',
    inputSchema: { type: 'object', properties: {
      range: { type: 'string', enum: ['1W', '1M', 'YTD', '1Y', 'All'], description: 'Default 1M.' },
      points: { type: 'boolean', description: 'Include the daily value/paid series.' },
    } },
    async run(a) {
      const d = await app.summary({});
      if (d.empty || !d.daily?.length) return { empty: true };
      const key = String(a.range || '1M').toUpperCase(), span = RANGES[key];
      if (!(key in RANGES)) throw new Error('range is one of 1W, 1M, YTD, 1Y, All');
      const start = span == null ? '0000' : span === 'ytd' ? `${d.today.slice(0, 4)}-01-01`
                  : new Date(Date.parse(d.today) - span * 864e5).toISOString().slice(0, 10);
      let pts = d.daily.filter(p => p.d >= start);
      if (pts.length < 2) pts = d.daily.slice(-2);
      const res = p => p.value - p.cost + p.realised, first = pts[0], last = pts.at(-1);
      const change = res(last) - res(first), base = Math.max(...pts.map(p => p.cost));
      return {
        range: a.range || '1M', from: first.d, to: last.d,
        result_eur: e(change), result_pct_of_invested: r2(base ? change / base * 100 : null), invested_max: e(base),
        value_start: e(first.value), value_end: e(last.value), paid_end: e(last.cost),
        realised_in_range: e(last.realised - first.realised),
        ...(a.points ? { daily: pts.map(p => ({ date: p.d, value: e(p.value), paid: e(p.cost) })) } : {}),
      };
    },
  },
  {
    name: 'today_intraday',
    description: 'Today\'s depot value through the day against yesterday\'s close, as recorded by tr-overview (every minute while the page is open, every 5 minutes while the server runs). Records a fresh point now.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const day = await app.intraday(55 * 1000);
      if (!day || day.date !== berlinToday()) return { recorded: false };
      const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      const now = day.points.at(-1)?.[1];
      return { date: day.date, previous_close: e(day.prevClose), now: e(now),
               change_eur: e(now - day.prevClose), change_pct: r2(day.prevClose ? (now / day.prevClose - 1) * 100 : null),
               points: day.points.map(([m, v]) => ({ time: hhmm(m), value: e(v) })) };
    },
  },
  {
    name: 'months',
    description: 'Month by month: money paid in, interest, dividends, price moves, tax + fees, what the month earned (€ and %), stocks value, cash, total. Plus the return per year since the start.',
    inputSchema: { type: 'object', properties: {
      from: { type: 'string', description: 'First month, YYYY-MM.' }, to: { type: 'string', description: 'Last month, YYYY-MM.' },
    } },
    async run(a) {
      const d = await app.summary({});
      if (d.empty) return { months: [] };
      return { return_per_year: perYear(d.annual), months: d.months.filter(m => (!a.from || m.month >= a.from) && (!a.to || m.month <= a.to)).map(m => ({
        month: m.month, partial: m.partial, paid_in: e(m.paidIn), interest: e(m.interest), dividends: e(m.dividends),
        price_move: e(m.market), tax_and_fees: e(m.taxes + m.fees), earned: e(m.result), return_pct: r2(m.returnPct),
        stocks: e(m.value), cash: e(m.cash), total: e(m.total) })) };
    },
  },
  {
    name: 'taxes',
    description: 'German tax on capital income for one year, this account only: how much of the Sparer-Pauschbetrag (1.000 € single / 2.000 € joint) is used, tax above it (26,375 %, more with church tax), estimate to 31 Dec, what selling every stock today would do, stock sales FIFO, crypto holding periods (§ 23). An estimate, not tax advice.',
    inputSchema: { type: 'object', properties: {
      year: { type: 'integer', description: 'Default: this year.' },
      joint: { type: 'boolean', description: 'Married, filing jointly (2.000 €).' },
      church: { type: 'number', enum: [0, 0.08, 0.09], description: 'Church tax rate.' },
    } },
    async run(a) {
      const d = await app.summary(settingsOf(a));
      if (d.empty) return { empty: true };
      const year = Number(a.year) || Number(d.today.slice(0, 4));
      const t = d.tax[year];
      if (!t) return { error: `no data for ${year}`, years: Object.keys(d.tax) };
      return {
        year, allowance: e(t.allowance), rate_pct: r2(t.rate * 100),
        counted: e(t.capital), left: e(t.left), over: e(t.over), tax: e(t.tax),
        parts: { interest: e(t.interest.gross), dividends_gross: e(t.dividends.gross), stock_gains: e(t.stockGains),
                 stock_losses: e(t.stockLosses), losses_carried_forward: e(t.lossCarried) },
        withheld_by_trade_republic: e(-t.withheld), refunded: e(t.refunded),
        ...(t.projection ? { estimate_31_dec: { counted: e(t.projection.capital), left: e(t.projection.left), tax: e(t.projection.tax),
                                                interest_payments_to_come: t.projection.interestPayments } } : {}),
        ...(t.sellAll ? { if_all_stocks_sold_today: { gain: e(t.sellAll.unrealised), counted_by_dec: e(t.sellAll.capital), tax: e(t.sellAll.tax) } } : {}),
        stock_sales: t.sales.map(s => ({ date: s.date, name: s.name, got: e(s.proceeds), paid: e(s.cost), gain: e(s.gain), tax_withheld: e(s.tax) })),
        crypto: { short_term_gain_this_year: e(t.crypto.shortTermGain), taxable: t.crypto.taxable,
                  holdings: (t.crypto.open || []).map(c => ({ name: c.name, bought: c.bought, tax_free_from: c.taxFreeFrom,
                                                              days_left: c.daysLeft, gain_now: e(c.gain) })) },
        note: 'Assumes the exemption order (Freistellungsauftrag) is at Trade Republic and no other capital income.',
      };
    },
  },
  {
    name: 'stock_analysis',
    description: 'One stock in depth: sector, country, market value, 52-week range, annual financials (revenue, EBITDA, net income, EPS since ~2016, EPS/dividend estimates, debt/equity, employees, ex-dividend dates), the last four years as filed (balance sheet, interest paid, minorities - `reported`), free cash flow, buybacks, dividends paid and share count for non-US ISINs (Yahoo - `cashflow`), directors\' dealings of German issuers (BaFin - `insiders`), splits and spin-offs, every venue it trades on (`listings`), CEO pay ratio; for shares listed in the US (also foreign ones like Brookfield on the NYSE) analysts (buy/hold/sell, price targets, upside), next earnings date, fund holders, short interest, and for US ISINs last quarters and reported years. For a fund or ETF instead (`fund`): ongoing charges, fund size, index, replication, accumulating/distributing, top holdings, countries, sectors, currencies, returns and returns against the index, volatility and max drawdown, payouts. Plus your position and trades in it.',
    inputSchema: { type: 'object', required: ['stock'], properties: {
      stock: { type: 'string', description: 'Name or ISIN, e.g. "Amazon", "Uber", "US0231351067".' },
    } },
    async run(a) {
      const { key } = await resolveStock(a.stock);
      const [an, d] = await Promise.all([app.analysis(key), app.summary({})]);
      const p = d.empty ? null : d.positions.find(x => x.key === key);
      return { ...an, your_position: p ? position(p, d.profiles) : null,
               your_trades: (d.trades?.[key] || []).map(t => ({ date: t.date, type: t.type, shares: t.shares, price: t.price, amount: e(t.amount) })) };
    },
  },
  {
    name: 'research',
    description: 'Everything to decide on one stock, held or not: a read-out made from the numbers (price vs 52 weeks, trend vs 50/200-day averages, beta, growth, profit, returns on equity/assets, free cash flow, balance sheet/net cash or as filed (liabilities vs equity, interest cover), 5-year earnings trend, analysts\' expected EPS growth (flagging estimates that measure another profit than the reported EPS), valuation incl. P/E on estimates and the next 12 months, P/E on the company\'s own profit measure, earnings yield vs 10-year euro bonds, P/E against its own past by year, P/B and P/CF vs own past, PEG, Graham number + checks, Buffett checks, Lynch (growth + yield) / P/E, Ackman checks, analysts, insider trades, short interest, fund holders, next results, what this week\'s headlines are about, dividend (payout, cuts over 10 years, spin-offs excepted, next year), CEO, listing currency, sources and their dates) - each point with a good/bad/neutral tone and the fixed rule behind it - plus the week\'s top stories. With `amount` (EUR) also what that buy does to the depot: its weight, the largest position, the mix by position, sector and country, and the share in US dollars before and after. For a fund or ETF: costs, size, index and replication, tracking vs index, returns by year, top 10 holdings (and overlap with the depot), countries, sectors, currencies, payouts, Teilfreistellung; its depot fit counts by what it holds. Stock by name, ISIN or US ticker ("SE").',
    inputSchema: { type: 'object', required: ['stock'], properties: {
      stock: { type: 'string', description: 'Name, ISIN or US ticker, e.g. "Sea Limited", "US81141R1005", "SE".' },
      amount: { type: 'number', description: 'Euros you think of buying, e.g. 5000.' },
    } },
    async run(a) {
      const { key } = await resolveStock(a.stock);
      const r = await app.research(key, Number(a.amount) || 0);
      const seen = new Set(), story = new Map();
      for (const i of r.news.filter(i => !seen.has(i.link) && seen.add(i.link))) {
        const g = story.get(i.story);
        if (g) g.from.add(i.source);
        else story.set(i.story, { title: i.title, source: i.source, at: i.at, link: i.link, from: new Set([i.source]), names_it: i.about });
      }
      // outlets: how many sites ran it - one site's 36 schedule pages are one outlet
      for (const g of story.values()) { g.outlets = g.from.size; delete g.from; }
      const f = r.fit;
      return {
        name: r.name, key: r.key, isin: r.isin, sector: r.profile?.sector ?? null, country: r.profile?.country ?? null,
        price_eur: r.quote?.last ?? null, today_pct: r.quote?.prev ? r2((r.quote.last / r.quote.prev - 1) * 100) : null,
        your_position: r.held && { shares: r.held.shares, value: e(r.held.value), gain_eur: e(r.held.gain), gain_pct: r2(r.held.gainPct), weight_pct: r2(r.held.weight) },
        readout: r.points.map(p => ({ group: p.group, topic: p.topic, tone: p.tone, head: p.head, text: p.text, ...(p.rule ? { rule: p.rule } : {}), ...(p.checks ? { checks: p.checks } : {}) })),
        numbers: Object.fromEntries(Object.entries(r.stats).map(([k, v]) => [k, typeof v === 'number' ? r2(v) : v])),
        // P/E against its own past: by year, lowest / middle / highest (market value ÷ net income)
        pe_history: r.pe && { now: r.pe.now != null ? r2(r.pe.now) : null, middle: r2(r.pe.median), since: r.pe.since, profit_until: r.pe.basis,
          by_year: Object.entries(r.pe.dates.reduce((o, d, i) => (r.pe.values[i] != null && (o[d.slice(0, 4)] ??= []).push(r.pe.values[i]), o), {}))
            .map(([year, v]) => (v.sort((x, y) => x - y), { year, low: r2(v[0]), middle: r2(v[Math.floor(v.length / 2)]), high: r2(v.at(-1)) })) },
        company_numbers: r.kpis && kpiOut(r.kpis),
        news_themes: r.themes,
        // headlines that name the company first: a keyword search also returns ones that only mention it
        top_stories: [...story.values()].sort((x, y) => y.names_it - x.names_it || y.outlets - x.outlets || y.at.localeCompare(x.at)).slice(0, 12),
        ...(f && a.amount ? { if_you_buy: {
          eur: e(f.amount), weight_after_pct: r2(f.weightAfter), stocks_and_crypto_after: e(f.totalAfter),
          largest_after: { name: f.largestAfter.name, weight_pct: r2(f.largestAfter.weight) },
          cash_at_trade_republic: e(f.cash),
          in_us_dollars_pct: { before: r2(f.usdBefore), after: r2(f.usdAfter), note: 'positions with a US ISIN, ADRs included' },
          positions_pct: f.positions.map(c => ({ name: c.name, before: r2(c.before), after: r2(c.after) })),
          sectors_pct: f.sectors.map(c => ({ sector: c.sector, before: r2(c.before), after: r2(c.after) })),
          countries_pct: f.countries.map(c => ({ country: c.country, before: r2(c.before), after: r2(c.after) })),
        } } : {}),
        notes: r.notes, errors: r.errors,
        note: 'Made from public data by fixed rules, not a recommendation.',
      };
    },
  },
  {
    name: 'company_numbers',
    description: 'The figures a company reports in its own quarterly results that no price feed has (Sea: Shopee GMV, take rate, loan book, NPL; Uber: trips; ...). Kept on this machine in data/kpis/<ISIN>.json. ONLY numbers read from the company\'s own results release or filing, each quarter with its `source` link and `reported` date - never from news, never estimated. get: the last 4 quarters with change on a year before. save: merge `metrics` (by id) and/or one `quarter` (by period). lines: the user\'s own green/red lines (data/kpi-lines.json).',
    inputSchema: { type: 'object', required: ['stock'], properties: {
      stock: { type: 'string', description: 'Name, ISIN or US ticker.' },
      action: { type: 'string', enum: ['get', 'save', 'lines'], description: 'Default get.' },
      metrics: { type: 'array', description: 'save: [{id: "gmv", label: "Shopee GMV", unit: "$bn"|"$m"|"bn"|"m"|"%", help: "what it is", earnings: true}] - earnings: true marks the company\'s own profit measure (Brookfield: distributable earnings, a REIT: FFO); the research read-out then shows a P/E on its last four quarters. One per company.',
                 items: { type: 'object' } },
      quarter: { type: 'object', description: 'save: {period: "2026-Q2", reported: "2026-08-11", source: "https://…", values: {gmv: 38.3, …}}' },
      lines: { type: 'object', description: 'lines: {metricId: {green, red}}. Judges the growth % of amounts and the level of rates (%). green above red = higher is better.' },
    } },
    async run(a) {
      const { key } = await resolveStock(a.stock);
      const action = a.action || 'get';
      const next = (await app.analysis(key).catch(() => null))?.us?.earningsDate;    // for "update due"
      if (action === 'save') await app.kpis.save(key, { metrics: a.metrics, quarter: a.quarter });
      if (action === 'lines') await app.kpis.lines(key, a.lines);
      const k = await app.kpis.get(key, next);
      return k.table ? { ...kpiOut(k.table), file: `data/kpis/${key}.json` }
                     : { none: true, file: `data/kpis/${key}.json`, note: 'No company numbers yet. Add metrics and a quarter with action save, from the company\'s own results release.' };
    },
  },
  {
    name: 'price_history',
    description: 'Daily closing prices in EUR (LS Exchange) for one stock or crypto, with your buys and sells. At most ~260 points (thinned for long ranges).',
    inputSchema: { type: 'object', required: ['stock'], properties: {
      stock: { type: 'string', description: 'Name or ISIN.' },
      from: { type: 'string', description: 'YYYY-MM-DD, default one year ago.' },
    } },
    async run(a) {
      const { key, name } = await resolveStock(a.stock);
      const from = a.from || new Date(Date.now() - 366 * 864e5).toISOString().slice(0, 10);
      const h = await app.history(key, from);
      const step = Math.max(1, Math.ceil(h.closes.length / 260));
      const closes = h.closes.filter((_, i) => i % step === 0 || i === h.closes.length - 1).map(([date, close]) => ({ date, close }));
      const d = await app.summary({});
      return { name, key, from: h.from, live: h.live, closes,
               your_trades: (d.trades?.[key] || []).filter(t => t.date >= h.from).map(t => ({ date: t.date, type: t.type, shares: t.shares, price: t.price })) };
    },
  },
  {
    name: 'news',
    description: 'Recent headlines (last 7 days, Google News) for every holding and followed stock, or for one stock. One entry per story; alsoIn lists the other outlets that ran it.',
    inputSchema: { type: 'object', properties: {
      stock: { type: 'string', description: 'Only this one (name or ISIN). Any stock works, not only holdings.' },
      lang: { type: 'string', enum: ['en', 'de'] },
      limit: { type: 'integer', description: 'Default 20.' },
    } },
    async run(a) {
      const one = a.stock ? await resolveStock(a.stock) : null;
      const n = await app.news(a.lang || 'en', one ? [one] : undefined);
      const seen = new Set(), story = new Map();
      for (const i of n.items.filter(i => !seen.has(i.link) && seen.add(i.link))) {
        const g = story.get(i.story);
        if (g) { if (i.source !== g.source && !g.alsoIn.includes(i.source)) g.alsoIn.push(i.source); }
        else story.set(i.story, { stock: i.name, title: i.title, source: i.source, at: i.at, link: i.link, alsoIn: [] });
      }
      return { headlines: [...story.values()].slice(0, Number(a.limit) || 20), errors: n.errors };
    },
  },
  {
    name: 'watchlist',
    description: 'Stocks you follow without holding them (shown in News, with their daily move). List, add by name/ISIN, or remove.',
    inputSchema: { type: 'object', properties: {
      action: { type: 'string', enum: ['list', 'add', 'remove'], description: 'Default list.' },
      stock: { type: 'string', description: 'For add/remove: name or ISIN.' },
    } },
    async run(a) {
      const action = a.action || 'list';
      if (action === 'add') return { added: await app.watchlist.add(a.stock) };
      if (action === 'remove') {
        const w = app.watchRaw(), t = String(a.stock || '').toLowerCase();
        const hit = w.find(x => x.key.toLowerCase() === t || x.name.toLowerCase().includes(t));
        if (!hit) throw new Error(`"${a.stock}" is not on the watchlist`);
        app.watchlist.remove(hit.key);
        return { removed: hit.name };
      }
      return { watchlist: (await app.watchlist.list()).map(w => ({ name: w.name, key: w.key, price: w.quote?.last ?? null,
               today_pct: w.quote?.prev ? r2((w.quote.last / w.quote.prev - 1) * 100) : null })) };
    },
  },
  {
    name: 'search_instrument',
    description: 'Find a stock, ETF or crypto by name, ISIN or US ticker (onvista; a ticker is matched by ISIN via OpenFIGI). Returns names, ISINs, types, the US listing (ticker, exchange) and exact: the ISIN or US ticker that was asked for.',
    inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } },
    async run(a) { return { results: (await app.search(a.query)).slice(0, 10).map(h => ({ name: h.name, isin: h.isin, type: h.type, key: h.key, us: h.us, exact: h.exact })) }; },
  },
  {
    name: 'import_export',
    description: 'Import a Trade Republic transaction export (CSV, from Trade Republic → Statements → Transaction export) from a file path into the data folder. Rows already there are skipped.',
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string', description: 'Absolute path, ~ allowed.' } } },
    async run(a) {
      const p = path.resolve(String(a.path).replace(/^~(?=\/|$)/, process.env.HOME || '~'));
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error(`no file at ${p}`);
      if (fs.statSync(p).size > 20 * 1024 * 1024) throw new Error('file is larger than 20 MB');
      const [r] = app.upload([{ name: path.basename(p), text: fs.readFileSync(p, 'utf8') }]);
      if (!r.ok) throw new Error(`${r.file}: ${r.reason}`);
      return r;
    },
  },
];

// ---------------------------------------------------------------- protocol

const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');
const log = (...a) => process.stderr.write(`[tr-overview mcp] ${a.join(' ')}\n`);

async function handle(msg) {
  const { id, method, params = {} } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    let result;
    if (method === 'initialize') {
      result = {
        protocolVersion: PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'tr-overview', version: VERSION },
        instructions: 'A Trade Republic depot from the user\'s own transaction exports, on this machine. Amounts in EUR. '
          + 'Start with `overview`. Stocks can be named loosely ("uber", "meta") or by ISIN. Prices: onvista, LS Exchange. '
          + 'Taxes are German (Sparer-Pauschbetrag) estimates for this account only. Never present anything as investment or tax advice.',
      };
    } else if (method === 'ping') {
      result = {};
    } else if (method === 'tools/list') {
      result = { tools: TOOLS.map(({ run, ...t }) => t) };
    } else if (method === 'tools/call') {
      const tool = TOOLS.find(t => t.name === params.name);
      if (!tool) throw Object.assign(new Error(`unknown tool ${params.name}`), { code: -32602 });
      try {
        const out = await tool.run(params.arguments || {});
        result = { content: [{ type: 'text', text: JSON.stringify(out, null, 1) }] };
      } catch (err) {                                   // a tool failure is a result the agent can read
        result = { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    } else if (method?.startsWith('notifications/')) {
      return;                                            // initialized, cancelled: nothing to answer
    } else {
      throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
    }
    if (isRequest) send({ jsonrpc: '2.0', id, result });
  } catch (err) {
    if (isRequest) send({ jsonrpc: '2.0', id, error: { code: err.code || -32603, message: err.message } });
    else log(err.message);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); }
    catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); continue; }
    for (const m of Array.isArray(msg) ? msg : [msg]) handle(m);
  }
});
process.stdin.on('end', () => process.exit(0));
log(`ready · data: ${app.dataDir}`);
