#!/usr/bin/env node
/**
 * Offline sanity checks on the model, against public/sample.csv. No network.
 *
 *   npm run check
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { mergeExports, replay, holdings, taxYear, taxSettings, months, xirr, annualReturns } from '../lib/portfolio.mjs';
import { stories, newsNames } from '../lib/news.mjs';
import { readout, themes } from '../lib/research.mjs';
import * as K from '../lib/kpis.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const text = fs.readFileSync(path.join(HERE, '..', 'public', 'sample.csv'), 'utf8');
const lines = text.trim().split('\n');
let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`ok    ${name}`); }
  catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message}`); }
};

const all = mergeExports([{ name: 'sample.csv', text }]);

check('every sample row is read', () => assert.equal(all.rows.length, lines.length - 1));

check('overlapping exports never double-count', () => {
  const half = Math.floor(lines.length / 2);
  const a = [lines[0], ...lines.slice(1, half + 5)].join('\n');
  const b = [lines[0], ...lines.slice(half - 5)].join('\n');
  const m = mergeExports([{ name: 'a.csv', text: a }, { name: 'b.csv', text: b }]);
  assert.equal(m.rows.length, all.rows.length);
});

check('a file that is not an export is refused', () => {
  const m = mergeExports([{ name: 'x.csv', text: 'date;amount\n2026-01-01;5' }]);
  assert.equal(m.files[0].ok, false);
  assert.equal(m.rows.length, 0);
});

check('cash = amount + fee + tax, walked forward', () => {
  const st = replay(all.rows);
  const sum = all.rows.reduce((s, r) => s + r.amount + r.fee + r.tax, 0);
  assert.equal(st.cash, sum);
});

check('a sale is priced FIFO, order fees on both sides', () => {
  const st = replay(all.rows);
  const sale = st.sales.find(s => s.name === 'Apple');
  const buy = all.rows.find(r => r.type === 'BUY' && r.name === 'Apple');
  const expectCost = Math.round((-buy.amount - buy.fee) * sale.shares / buy.shares);
  assert.equal(sale.cost, expectCost);
  assert.equal(sale.gain, sale.proceeds - sale.cost);
});

check('the sold share leaves the position', () => {
  const st = replay(all.rows);
  const apple = holdings(st).find(h => h.name === 'Apple');
  const bought = all.rows.filter(r => r.type === 'BUY' && r.name === 'Apple').reduce((s, r) => s + r.shares, 0);
  assert.ok(Math.abs(apple.shares - (bought - 1)) < 1e-6);
});

check('tax rates: 26,375 % / 27,819 % / 27,995 %', () => {
  assert.equal(taxSettings().rate.toFixed(5), '0.26375');
  assert.equal(taxSettings({ church: 0.08 }).rate.toFixed(5), '0.27819');
  assert.equal(taxSettings({ church: 0.09 }).rate.toFixed(5), '0.27995');
  assert.equal(taxSettings({ joint: true }).allowance, 200000);
});

check('allowance: interest + dividends + stock gains, nothing over -> no tax', () => {
  const t = taxYear(all.rows, 2025, null, '2025-12-31');
  const interest = all.rows.filter(r => r.type === 'INTEREST_PAYMENT' && r.date.startsWith('2025')).reduce((s, r) => s + r.amount, 0);
  const divs = all.rows.filter(r => r.type === 'DIVIDEND' && r.date.startsWith('2025')).reduce((s, r) => s + r.amount, 0);
  assert.equal(t.capital, interest + divs);
  assert.equal(t.tax, 0);
});

check('over the allowance, the excess is taxed at the rate', () => {
  const t = taxYear(all.rows, 2025, null, '2025-12-31', { allowance: 1000, rate: 0.26375 });
  assert.equal(t.over, t.capital - 1000);
  assert.equal(t.tax, Math.round(t.over * 0.26375));
});

check('months: what a month earned excludes money paid in', () => {
  const ms = months(all.rows, {}, {}, '2026-09-30');
  for (let i = 1; i < ms.length; i++) {
    assert.equal(ms[i].result, ms[i].total - ms[i - 1].total - ms[i].paidIn);
  }
});

check('per year: 1.000 € grown to 1.100 € in a year is +10 %', () => {
  assert.ok(Math.abs(xirr([['2024-01-01', -100000]], '2024-12-31', 110000) - 10) < 0.05);
});

check('per year: money paid in late weighs only the time it was in', () => {
  // +100 € on 1.000 € held a year, plus 9.000 € paid in a month before the end that broke even.
  // Gain / most invested says 1 %; one rate r with 1.000(1+r) + 9.000(1+r)^(1/12) = 10.100 is ~5,8 %
  const r = xirr([['2024-01-01', -100000], ['2024-12-01', -900000]], '2024-12-31', 1010000);
  assert.ok(r > 5.5 && r < 6.1, `got ${r}`);
});

check('per year: under a year of data there is no number', () => {
  const a = annualReturns(all.rows, all.rows[0].date, 0, 0);
  assert.equal(a.all.pct, null);
});

check('news: one story told by several outlets is one row, other news stays apart', () => {
  const h = (title, key = 'uber', at = '2026-10-06T10:00:00Z') => ({ title, key, name: key === 'uber' ? 'Uber' : 'Micron Technology', at });
  const g = stories([
    h('Uber to buy ezCater for $2.3B, boosts Eats'),
    h('Uber to buy US catering platform ezCater for $2.3 billion'),
    h('Uber Eats Enters Catering Space With $2.3 Billion ezCater Deal'),
    h('Las Vegas Uber drivers say rising fares haven’t meant higher pay'),
    h('Las Vegas Uber drivers say rising fares haven’t meant higher pay', 'uber', '2026-10-06T11:00:00Z'),
    h('Las Vegas Uber drivers say rising fares haven’t meant higher pay', 'uber', '2026-10-01T11:00:00Z'),
    h('Rising UFC fighter ended up in an Uber to Jon Jones’ mansion after-party'),
    h('Micron enters $600 million settlement of Netlist patent dispute', 'mu'),
    h('Micron Technology, Netlist Settle Patent Dispute for $600 Million', 'mu'),
    h('Micron: The Market Still Doesn’t Get It (NASDAQ:MU)', 'mu'),
    h('Micron Technology: Not At Its Peak, At Least Not Yet (NASDAQ:MU)', 'mu'),
  ]).map(x => x.story);
  assert.deepEqual(g, [0, 0, 0, 3, 3, 5, 6, 7, 7, 9, 10]);
});

check('news: searched by the company name and its other company names in brackets, not brands or share classes', () => {
  assert.deepEqual(newsNames('Pinduoduo (PDD Holdings, Temu)'), ['Pinduoduo', 'PDD Holdings']);
  assert.deepEqual(newsNames('Sea Limited (ADR)'), ['Sea Limited']);
  assert.deepEqual(newsNames('Alphabet (A) (ehem. Google)'), ['Alphabet']);
});

check('research: themes count stories that name the company, once per story', () => {
  const n = [
    { title: 'SEA (NYSE:SE) Insider Sells 40,000 Shares of Stock', source: 'A', story: 1, link: 'a' },
    { title: 'SEA (NYSE:SE) Insider Sells 40,000 Shares of Stock', source: 'B', story: 1, link: 'b' },
    { title: 'Sea Limited downgraded to Hold', source: 'C', story: 2, link: 'c' },
    { title: 'Holland America unveils lodge upgrades', source: 'D', story: 3, link: 'd' },
  ];
  const t = Object.fromEntries(themes(n, ['Sea', 'SE']).map(x => [x.id, x.stories]));
  assert.deepEqual(t, { insider: 1, downgrade: 1 });
});

check('research: buying moves weight and country mix, rules colour the points', () => {
  const an = { key: 'US81141R1005', name: 'Sea Limited (ADR)', type: 'STOCK', isin: 'US81141R1005',
               profile: { country: 'Singapore', sector: 'Retail' }, annual: [], notes: [],
               us: { price: 100, years: [{ period: '2024-12-31', revenue: 100, netIncome: 5 }, { period: '2025-12-31', revenue: 140, netIncome: 10 }],
                     market: { marketCap: 400 }, epsForecast: [], analysts: null } };
  const depot = { cash: 100000, positions: [{ key: 'US90353T1007', name: 'Uber', value: 500000, country: 'USA', sector: 'Transport' }] };
  const r = readout({ an, depot, amount: 5000, today: '2026-10-07' });
  assert.equal(Math.round(r.fit.weightAfter), 50);
  assert.deepEqual(r.fit.countries.map(c => [c.country, Math.round(c.before), Math.round(c.after)]), [['USA', 100, 50], ['Singapore', 0, 50]]);
  assert.deepEqual(r.fit.sectors.map(c => [c.sector, Math.round(c.before), Math.round(c.after), c.mine]), [['Transport', 100, 50, false], ['Retail', 0, 50, true]]);
  assert.deepEqual(r.fit.positions.map(c => [c.name, Math.round(c.after), c.mine]), [['Uber', 50, false], ['Sea Limited (ADR)', 50, true]]);
  assert.equal(r.fit.usdAfter, 100);                    // an ADR is still dollars
  const tone = Object.fromEntries(r.points.map(p => [p.topic, p.tone]));
  assert.equal(tone.Growth, 'good');                     // +40 %
  assert.equal(tone['In your depot'], 'bad');            // 50 % in one stock, and more than the cash
  assert.equal(r.stats.pe, 40);
  assert.match(r.points.find(p => p.topic === 'In your depot').text, /More than your cash/);
});

check('research: balance sheet, cash flow, returns, insiders, short interest, funds, trend', () => {
  const an = { key: 'US0000000001', name: 'X', type: 'STOCK', isin: 'US0000000001', profile: { shares: 1000 }, annual: [], notes: [],
               risk: { beta: 1.5, benchmark: 'MSCI World', volatility: 50 },
               us: { price: 10, market: { marketCap: 10000, volume: 300, avgVolume: 200 }, epsForecast: [], analysts: null,
                     peg: { value: 0.98, growth: [{ year: '2026', pct: 15.67 }] },
                     years: [{ period: '2024-12-31', revenue: 800, netIncome: 40, operatingCashFlow: 90, capex: -10 },
                             { period: '2025-12-31', revenue: 1000, grossProfit: 450, operatingIncome: 90, netIncome: 60, equity: 400, totalAssets: 1200,
                               cash: 300, shortInvestments: 100, shortDebt: 150, longDebt: 50, currentAssets: 600, currentLiabilities: 400,
                               operatingCashFlow: 120, capex: -20, stock: 5 }],
                     insiders: { m3: { buys: 0, sells: 12, bought: 0, sold: 20 }, m12: { buys: 1, sells: 30 }, recent: [{ type: 'Automatic Sell' }, { type: 'Sell' }] },
                     shortInterest: { date: '2026-09-15', shares: 30, changePct: 0.01, daysToCover: 3.2 },
                     institutions: { pct: 70.6, holders: 891, increased: 445, decreased: 327, newHolders: 122, soldOut: 91, asOf: '2026-06-30', top: [] } } };
  // 250 days rising from 5 to 9.98, then the price drops to 8: under its 50-day, over its 200-day
  const closes = Array.from({ length: 250 }, (_, i) => [new Date(Date.UTC(2025, 9, 1) + i * 864e5).toISOString().slice(0, 10), 5 + i * 0.02]);
  const r = readout({ an, closes, quote: { last: 8 }, today: '2026-10-07' });
  const pt = Object.fromEntries(r.points.map(p => [p.topic, p]));
  assert.equal(pt['Balance sheet'].tone, 'good');              // 400 cash vs 200 debt
  assert.equal(r.stats.netCash, 200);
  assert.equal(r.stats.currentRatio, 1.5);
  assert.equal(pt['Cash flow'].tone, 'good');                  // free 100, a year before 80
  assert.equal(r.stats.fcfYield, 1);
  assert.equal(pt.Returns.tone, 'good');                       // 60 / 400 = 15 %
  assert.equal(pt.Insiders.tone, 'bad');                       // sold, no buys
  assert.match(pt.Insiders.text, /1 of the latest 2 under a pre-set trading plan/);
  assert.equal(pt['Short interest'].tone, 'good');             // 3 % of 1000 shares
  assert.match(pt['Short interest'].text, /About the same/);
  assert.equal(pt.Funds.tone, 'good');                         // 445 added > 327 cut
  assert.equal(pt.Trend.tone, 'neutral');
  assert.equal(r.stats.pb, 25);
  assert.equal(r.stats.peg, 0.98);
  assert.match(pt.Valuation.text, /\+16 % in 2026/);
  assert.match(pt.Swings.text, /1,50/);
});

check('research: Graham number, Buffett checks, Lynch ratio, Ackman checks by their rules', () => {
  // 100 shares at 10 $: EPS 1, book 4 a share, analysts 1 -> 1,21 in two years (+10 % a year)
  const an = { key: 'US0000000002', name: 'Y', type: 'STOCK', isin: 'US0000000002', profile: {}, annual: [], notes: [],
               us: { price: 10, market: { marketCap: 1000 }, analysts: null, dividends: [{ exDate: '2026-06-01', amount: 0.5 }],
                     epsForecast: [{ year: '2026', eps: 1.1 }, { year: '2027', eps: 1.21 }],
                     years: [2022, 2023, 2024, 2025].map(y => ({ period: `${y}-12-31`, revenue: 500, grossProfit: 250, operatingIncome: 150,
                       netIncome: 100, equity: 400, totalAssets: 800, cash: 50, shortDebt: 100, longDebt: 200,
                       currentAssets: 300, currentLiabilities: 100, operatingCashFlow: 120, capex: -20 })) } };
  const r = readout({ an, closes: [], quote: { last: 9 }, today: '2026-10-07' });
  const pt = Object.fromEntries(r.points.map(p => [p.topic, p]));
  assert.equal(r.stats.grahamNumber, Math.sqrt(22.5 * 1 * 4));   // 9,49 $ < price 10 $
  assert.equal(pt.Graham.tone, 'bad');
  assert.deepEqual(pt.Graham.checks.slice(0, 3), [{ label: 'P/E ≤ 15 (10)', ok: true }, { label: 'P/E × P/B ≤ 22,5 (25)', ok: false }, { label: 'current ratio ≥ 2 (3)', ok: true }]);
  assert.equal(pt.Graham.group, 'value');
  assert.equal(pt.Buffett.head, '5 of 5 checks');
  assert.equal(r.stats.buffettPassed, 5);                          // ROE 25 %, margin 50 %, debt 3 years, steady
  assert.equal(pt.Buffett.tone, 'good');
  assert.equal(Math.round(r.stats.lynchGrowth), 10);
  assert.equal(r.stats.lynchRatio.toFixed(2), '1.50');            // (10 + 5 % dividend) / P/E 10
  assert.equal(pt.Lynch.tone, 'good');
  // Ackman: flat revenue fails "up every year"; free cash 100 a year, debt 3 years of it, yield 10 %, margin 30 %
  assert.deepEqual(pt.Ackman.checks.map(c => c.ok), [true, false, true, true, true]);
  assert.equal(pt.Ackman.tone, 'good');
});

check('company numbers: change on a year before, as reported when given; lines judge growth or level', () => {
  const f = K.clean({ company: 'X', isin: 'US0000000001', metrics: [
    { id: 'gmv', label: 'GMV', unit: '$bn' }, { id: 'npl', label: 'NPL', unit: '%' }, { id: 'loans', label: 'Loans', unit: '$bn' }],
    quarters: [
      { period: '2025-Q2', reported: '2025-08-12', values: { gmv: 30, npl: 1.2, loans: 6.9 } },
      { period: '2026-Q2', reported: '2026-08-11', values: { gmv: 39, npl: 1.0, loans: 11.1 }, changes: { loans: 62.5 } },
    ] });
  const t = K.table(f, { gmv: { green: 25, red: 10 }, npl: { green: 1.5, red: 3 } }, { today: '2026-10-07', nextResults: '2026-11-10' });
  const row = id => t.rows.find(r => r.id === id).cells.at(-1);
  assert.equal(Math.round(row('gmv').change), 30);                     // 39 / 30
  assert.equal(row('npl').change.toFixed(1), '-0.2');                   // points, not %
  assert.equal(row('loans').change, 62.5);                              // the release's own number beats 11,1 / 6,9
  assert.deepEqual(t.rows.map(r => r.tone), ['good', 'good', null]);    // growth 30 >= 25; NPL 1,0 <= 1,5; no line
  assert.equal(t.due, false);
  assert.equal(K.table(f, {}, { today: '2026-11-11', nextResults: '2026-11-10' }).due, true);
  assert.throws(() => K.clean({ metrics: [{ id: 'gmv', label: 'GMV', unit: '$bn' }], quarters: [{ period: '2026-2', values: {} }] }));
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
