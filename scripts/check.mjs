#!/usr/bin/env node
/**
 * Offline sanity checks on the model, against public/sample.csv. No network.
 *
 *   npm run check
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mergeExports, replay, holdings, taxYear, taxSettings, months, xirr, annualReturns, homeCurrency, currencySplit } from '../lib/portfolio.mjs';
import { stories, newsNames, otherNames, localNews } from '../lib/news.mjs';
import { readout, themes, naming, peAhead, upDown, score, results } from '../lib/research.mjs';
import { dropSpikes } from '../lib/market.mjs';
import * as K from '../lib/kpis.mjs';
import { sectorOf, mainListing, markFiled, mergeEstimates, fyLabel } from '../lib/analysis.mjs';
import { pickSite } from '../lib/website.mjs';
import { buysOf } from '../lib/congress.mjs';
import { parseEstimates } from '../lib/yahoo.mjs';

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
  assert.deepEqual(newsNames('On Holding'), ['On Holding']);           // not "On": a word in every headline
  assert.deepEqual(newsNames('Siemens Group'), ['Siemens']);
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

check('research: a beat or a miss is one against the numbers, not a game', () => {
  const n = [
    { title: "Boys soccer: L-Cats lose high-scoring game to Brookfield Academy, beat St. John's", source: 'A', story: 1, link: 'a' },
    { title: 'Brookfield beats Q3 estimates as inflows hit a record', source: 'B', story: 2, link: 'b' },
    { title: 'Brookfield shares slide after earnings miss', source: 'C', story: 3, link: 'c' },
    { title: "Don't miss Brookfield's investor day", source: 'D', story: 4, link: 'd' },
  ];
  const t = Object.fromEntries(themes(n, ['Brookfield']).map(x => [x.id, x.stories]));
  assert.deepEqual(t, { beat: 1, miss: 1 });
});

check('news: a sister company is not the company - "Brookfield Renewable" is not Brookfield, "ASML Holding" is ASML', () => {
  const hits = ['Brookfield', 'Brookfield Renewable', 'Brookfield Asset Management', 'Brookfield Corporation', 'Brookfield Renewable Partners']
    .map(name => ({ name, type: 'STOCK' }));
  const others = otherNames('Brookfield', hits);
  assert.deepEqual(others, ['Brookfield Renewable', 'Brookfield Asset Management', 'Brookfield Renewable Partners']);
  assert.deepEqual(otherNames('ASML (ADR)', [{ name: 'ASML Holding', type: 'STOCK' }]), []);
  const about = naming(['Brookfield', 'BN'], others);
  assert.equal(about('Brookfield Renewable Partners (NYSE:BEP) Given a $38.00 Price Target'), false);
  assert.equal(about('Brookfield Asset Management (TSX:BAM) Stock Looks Fully Priced'), false);
  assert.equal(about('Brookfield commits $444 million to ESR India warehouse parks deal'), true);
  assert.equal(about('Brookfield (NYSE:BN) and Brookfield Renewable sign AI power deal'), true);
});

check('news: a company with its name inside another\'s - "Owens Corning" (also "Owens-Corning") is not Corning; town news is not company news', () => {
  const others = otherNames('Corning', [{ name: 'Corning', type: 'STOCK' }, { name: 'Owens Corning', type: 'STOCK' }]);
  assert.deepEqual(others, ['Owens Corning']);
  const about = naming(['Corning', 'GLW'], others);
  assert.equal(about('Truist Cuts Price Target on Owens Corning to $115 From $140, Keeps Hold Rating'), false);
  assert.equal(about('Owens-Corning Q2FY26 Results: Revenue flat at $2.8 billion, EBITDA margin holds 24%'), false);
  assert.equal(about('Corning signs USD 3 billion deal: 18 analysts rate Corning stock Buy'), true);
  assert.equal(localNews({ title: 'Horseheads boys soccer defeats Corning in overtime, Wednesday night scoreboard', source: 'WENY News' }), true);
  assert.equal(localNews({ title: 'Owego Free Academy Girls Varsity Volleyball @ Corning-Painted Post', source: 'MaxPreps' }), true);
  assert.equal(localNews({ title: 'Corning stock loses 3.15 percent versus its prior close', source: 'AD HOC NEWS' }), false);
  assert.equal(localNews({ title: "Obituary | Joan E. Fleming Obituary (2026) - Corning, NY - Carpenter's Funeral Home", source: 'Legacy' }), true);
  assert.equal(localNews({ title: 'Two Missouri Residents Arrested After Corning Traffic Stop, Sheriff Says', source: 'NEA Report' }), true);
  assert.equal(localNews({ title: 'Corning has a zest for the Olive Fest', source: 'appeal-democrat.com' }), true);
  assert.equal(localNews({ title: 'Corning Declares Quarterly Dividend, Payable on December 11, 2026', source: 'marketscreener.com' }), false);
  assert.equal(localNews({ title: 'Amazon Thursday Night Football ratings hit a record on Prime Video', source: 'CNBC' }), false);
});

check('prices: a stray close never adjusted for a split is left out, a real jump stays', () => {
  const s = [['2025-10-08', 38.67], ['2025-10-09', 38.67], ['2025-10-10', 58], ['2025-10-15', 39], ['2025-10-16', 37.2]];
  assert.deepEqual(dropSpikes(s).map(([d]) => d), ['2025-10-08', '2025-10-09', '2025-10-15', '2025-10-16']);
  const jump = [['a', 10], ['b', 14], ['c', 14.2], ['d', 14.1]];   // up 40 % and stays: a price, not a print
  assert.equal(dropSpikes(jump).length, 4);
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

check('research: a fund by its costs, size, holdings, payouts - and in the depot by what it holds', () => {
  const an = { key: 'IE0000000001', name: 'Europe ETF', type: 'FUND', isin: 'IE0000000001', profile: null, annual: [], notes: [],
               fund: { ter: 0.3, size: 50e6, use: 'distributing', equity: true, replication: 'sampling', index: 'MSCI EUROPE INDEX',
                       holdings: [{ name: 'ASML Holding', isin: 'NL0010273215', pct: 9.7 }, { name: 'Allianz', isin: 'DE0008404005', pct: 3 }],
                       countries: [{ name: 'Netherlands', pct: 60 }, { name: 'Germany', pct: 40 }], sectors: [{ name: 'Technology', pct: 100 }],
                       currencies: [{ name: 'EUR', pct: 90 }, { name: 'USD', pct: 10 }], vsIndex: { '1Y': -0.1, '3Y': -0.6 },
                       returns: { y1: 14, y3: 55, years: [] }, risk: {},
                       payouts: [{ date: '2025-12-11', amount: 0.5 }, { date: '2026-06-11', amount: 1.5 }] } };
  const depot = { cash: 0, positions: [{ key: 'USN070592100', name: 'ASML (ADR)', value: 10000, country: 'Netherlands', sector: 'Technology' },
                                       { key: 'US0000000009', name: 'Z', value: 10000, country: 'USA', sector: 'Transport' }] };
  const r = readout({ an, quote: { last: 50 }, depot, amount: 100, today: '2026-10-07' });
  const pt = Object.fromEntries(r.points.map(p => [p.topic, p]));
  assert.equal(pt.Costs.tone, 'neutral');                     // 0,30 % - between 0,20 and 0,50
  assert.equal(pt.Size.tone, 'bad');                          // under 100 m €
  assert.equal(pt.Tracking.tone, 'good');                     // −0,2 % a year on 3 years: within 0,5
  assert.match(pt.Holdings.text, /already hold ASML Holding/);  // the ADR is the same company
  assert.equal(pt.Payouts.head, '4 % yield');                 // 2 € on 50 €
  assert.equal(pt.Index.text.includes('MSCI Europe Index'), true);
  assert.equal(pt.Data, undefined);                           // no price, no fund date: nothing to cite
  const c = Object.fromEntries(r.fit.countries.map(x => [x.country, x]));
  assert.equal(c.Netherlands.after.toFixed(1), '53.3');      // the ADR 100 € + 60 % of the 100 € bought, of 300 €
  assert.equal(c.Germany.mine && c.Netherlands.mine && !c.USA.mine, true);
  assert.equal(r.fit.usdAfter.toFixed(1), '70.0');          // the ADR, Z and 10 % of the fund
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

check('research: home listings - estimates on another profit, next 12 months, dividend record, balance sheet as filed', () => {
  // analysts expect 3 € for 2026 against 1 € reported: another profit (Brookfield: distributable earnings vs IFRS)
  const eps = [0.5, 0.55, 0.6, 0.62, 0.7, 0.8, 0.9, 0.95, 1, 1];
  const dps = [0.2, 0.22, 0.24, 0.26, 0.28, 0.3, 0.32, 0.16, 0.18, 0.21];          // 2023: the year after a spin-off
  const an = { key: 'CA0000000001', name: 'Z', type: 'STOCK', isin: 'CA0000000001', notes: [],
               profile: { marketCap: 3000, marketCapCurrency: 'EUR', shares: 100 },
               splits: [{ date: '2022-12-12', factor: 1.2439 }],
               annual: [...eps.map((e, i) => ({ label: String(2016 + i), estimate: false, eps: e, dps: dps[i], dpsAdj: dps[i], pb: 2, divYield: 1 })),
                        { label: '2026', estimate: true, eps: 3, dps: 0.5 }, { label: '2027', estimate: true, eps: 3.6 }],
               reported: [{ label: '2022', equity: 400, minorities: 0, liabilities: 600, totalAssets: 1000 },
                          { label: '2025', end: '2025-12-31', currency: 'EUR', standard: 'IFRS', netIncome: 100, equity: 500, minorities: 0,
                            totalAssets: 1200, liabilities: 700, currentAssets: 300, currentLiabilities: 200, pretax: 120, interestPaid: 20, cash: 50 }],
               // Yahoo, in pence: 2.600 p against 2.000 p is +30 %, whatever the euro price
               targets: { currency: 'GBp', price: 2000, target: 2600, low: 2200, high: 3000, analysts: 5, recommendation: 'buy', evEbitda: 9.5 } };
  const r = readout({ an, closes: [], quote: { last: 30 }, today: '2026-10-07', rates: { date: '2026-10-06', bond10y: 3.5, fx: {} } });
  const pt = Object.fromEntries(r.points.map(p => [p.topic, p]));
  assert.equal(r.stats.pe, 30);                                       // on the reported 1 €
  assert.equal(pt.Analysts.head, '5 analysts · target +30 %');        // no Nasdaq: Yahoo's
  assert.match(pt.Analysts.text, /Average target 39,00 € \(\+30 %\), range 33,00–45,00 € - Yahoo, in euros at today's price \(theirs in GBp\)/);
  assert.equal(pt.Analysts.tone, 'good');
  assert.match(pt.Valuation.text, /EV\/EBITDA 9,5 \(Yahoo\)/);
  // a euro target counts as it is: 39 € against today's 30 €, not rescaled by Yahoo's own (other) price
  const eu = readout({ an: { ...an, targets: { currency: 'EUR', price: 32, target: 39, low: 33, high: 45, analysts: 5, recommendation: 'buy' } },
                       closes: [], quote: { last: 30 }, today: '2026-10-07', rates: { date: '2026-10-06', bond10y: 3.5, fx: {} } });
  assert.equal(eu.points.find(p => p.topic === 'Analysts').head, '5 analysts · target +30 %');
  assert.equal(Math.round(r.stats.ntmPe * 100), 867);                 // 23 % of 2026 left: 0,23 × 3 + 0,77 × 3,6
  assert.equal(r.stats.peg, undefined);                               // onvista's PEG mixes the two profits
  assert.match(pt.Valuation.text, /3× the reported 1,00 €/);
  assert.equal(Math.round(r.stats.lynchGrowth), 20);                  // 3 -> 3,6: estimate to estimate
  assert.equal(r.stats.lynchRatio.toFixed(2), '2.10');                // (20 + 1) ÷ P/E 10 on 2026
  assert.equal(pt.Outlook.tone, 'good');
  assert.deepEqual(pt.Dividend.checks.map(c => c.ok), [true, true, true, null]);   // 21 % paid out; the spin-off drop is no cut
  assert.equal(pt.Dividend.tone, 'good');
  assert.equal(r.stats.withheld, null);                               // no country, no withholding
  const ca = readout({ an: { ...an, profile: { ...an.profile, country: 'Canada' } }, closes: [], quote: { last: 30 }, today: '2026-10-07' });
  assert.equal(ca.stats.yieldAfterTax.toFixed(3), '0.451');           // 0,7 % × (1 − 25 % − 10 % × 1,055)
  assert.match(ca.points.find(p => p.topic === 'Dividend').text, /the other 10 % comes back only if you reclaim it there/);
  assert.equal(r.stats.interestCover, 7);                             // (120 + 20) ÷ 20
  assert.equal(pt['Balance sheet'].tone, 'good');                     // liabilities 1,4× equity, from 1,5×
  assert.equal(pt.Returns.head, 'ROE 20 %');
  assert.equal(Math.round(r.stats.earningsGrowthYearly * 10), 74);    // 0,7 € (2020) -> 1 € (2025)
  // Yahoo's share count: a 3:2 split between 2024 and 2025 shows as a jump, another year already adjusted does not
  const cashflow = { currency: 'USD', years: [{ year: '2023', end: '2023-12-31', free: 10, shares: 100 }, { year: '2024', end: '2024-12-31', free: 12, shares: 98 },
                                             { year: '2025', end: '2025-12-31', free: 15, shares: 145.53, buybacks: -33.81 }] };
  const y = readout({ an: { ...an, cashflow, splits: [{ date: '2025-10-10', factor: 1.5 }, { date: '2024-06-01', factor: 2 }] },
                      closes: [], quote: { last: 30 }, today: '2026-10-07', rates: { fx: { EUR: 1, USD: 1.127 } } });
  assert.equal(y.stats.sharesChangeYearly.toFixed(1), '-1.5');        // 150 -> 145,53 over 2 years
  assert.equal(y.stats.buybackYield.toFixed(2), '1.00');              // 33,81 $ = 30 € of 3.000 €
  assert.equal(y.points.find(p => p.topic === 'Cash flow').tone, 'good');
  assert.equal(pt.Valuation.head, 'P/E 10 on 2026 est. · 30 on 2025');   // on estimates first, as most sites show it
  const bank = readout({ an: { ...an, profile: { ...an.profile, kind: 'bank' } }, closes: [], quote: { last: 30 }, today: '2026-10-07' });
  assert.equal(bank.points.find(p => p.topic === 'Balance sheet').tone, 'neutral');
});

check('research: Nasdaq\'s last year lags onvista\'s - the newer one counts', () => {
  // Nasdaq to Aug 2025 with 1 $ a share; onvista already has 25/26 with 8 €
  const an = { key: 'US0000000003', name: 'M', type: 'STOCK', isin: 'US0000000003', notes: [], profile: { shares: 100 },
               annual: [{ label: '23/24', eps: 1.2, revenue: 400, netIncome: 120 }, { label: '24/25', eps: 1, revenue: 300, netIncome: 100 },
                        { label: '25/26', eps: 8, revenue: 1000, netIncome: 800, roe: 60, ebitMargin: 70 }, { label: '26/27', estimate: true, eps: 16 }],
               us: { price: 100, market: { marketCap: 10000 }, epsForecast: [{ year: '2027', eps: 18 }],
                     years: [{ period: '2024-08-29', revenue: 250, netIncome: 80 },
                             { period: '2025-08-28', revenue: 330, netIncome: 100, operatingCashFlow: 120, capex: -100, equity: 500, totalAssets: 900, cash: 10, longDebt: 50 }] } };
  const r = readout({ an, closes: [], quote: { last: 80 }, today: '2026-10-07' });
  const pt = Object.fromEntries(r.points.map(p => [p.topic, p]));
  assert.equal(r.stats.pe, 10);                                       // 80 € ÷ 8 €, not 10.000 $ ÷ 100 $ = 100
  assert.equal(pt.Valuation.head, 'P/E 5 on 26/27 est. · 10 on 25/26');
  assert.match(pt.Growth.text, /^Revenue 25\/26/);
  assert.match(pt.Data.text, /onvista already has 25\/26: the newer one is used/);
  // its cash flow and balance sheet stay out too: 20 $ free cash flow a year ago is no yield on today's price
  assert.equal(r.stats.fcfYield, undefined);
  assert.equal(pt['Balance sheet'], undefined);
  // Ackman with two checks known (revenue fell in 24/25, margin 70 %): too few to judge - grey, not red
  assert.deepEqual(pt.Ackman.checks.map(c => c.ok), [null, false, true, null, null]);
  assert.equal(pt.Ackman.tone, 'neutral');
  assert.match(pt.Ackman.text, /too few to judge/);
});

check('research: the P/E line goes on into the estimates, if the price stays', () => {
  // points 181 days apart; P/E 10 now, 5 on 2027 (ends 31 Dec 2027): 3 points, EPS in a straight line
  const pe = { dates: ['2026-01-01', '2026-07-01'], values: [12, 10] };
  const a = peAhead(pe, [{ year: '2026', pe: 8 }, { year: '2027', pe: 5 }]);
  assert.deepEqual(a.knots.map(k => [k.year, a.dates[k.i], a.values[k.i]]), [['2026', '2026-12-31', 8], ['2027', '2027-12-31', 5]]);
  const b = peAhead(pe, [{ year: '2027', pe: 5 }]);
  assert.deepEqual(b.values.map(v => +v.toFixed(2)), [7.5, 6, 5]);           // 1 ÷ (0,1 + 0,1 × 1/3), 1 ÷ (0,1 + 0,1 × 2/3), 5
  assert.equal(b.dates.at(-1), '2027-12-31');
  // a loss or over 100 now: nothing until the first estimate; none above 100; years already over left out
  const c = peAhead({ dates: pe.dates, values: [12, null] }, [{ year: '2025', pe: 9 }, { year: '2027', pe: 120 }]);
  assert.deepEqual(c.values, [null, null, null]);
  assert.deepEqual(c.knots.map(k => k.year), ['2027']);
  assert.equal(peAhead(pe, [{ year: '2025', pe: 9 }]), null);
});

check('research: up to the analysts\' target, down to the 200-day average or the 52-week low; the score', () => {
  // 300 closes rising 1 € a day from 1 €: the 200-day average on the last day is (101 + ... + 300) ÷ 200 = 200,5
  const closes = Array.from({ length: 300 }, (_, i) => [new Date(Date.UTC(2025, 9, 8) + i * 864e5).toISOString().slice(0, 10), i + 1]);
  const at = { target: 150, low: 110, high: 300, price: 100, n: 10 };             // dollars: +50 %
  const u = upDown(closes, 300, { ma200: 200.5, low52: 1 }, at, '2026-08-03');
  assert.equal(Math.round(u.up), 50);
  assert.equal(u.target, 450);                                                     // 300 € × 150 $ ÷ 100 $
  assert.deepEqual([u.downTo, u.level, +u.down.toFixed(2)], ['200-day average', 200.5, -33.17]);
  assert.equal(+u.ratio.toFixed(2), 1.51);
  assert.equal(u.analysts, 10);
  assert.equal(u.ma200.at(-1), 200.5);                                             // the running average ends where the stat does
  assert.equal(u.ma200[u.dates.indexOf(closes[198][0])], null);                    // under 200 closes: none
  // under its 200-day average: down to the 52-week low; no analysts: no up, no ratio
  const v = upDown(closes, 150, { ma200: 200.5, low52: 120 }, null, '2026-08-03');
  assert.deepEqual([v.up, v.downTo, Math.round(v.down), v.ratio], [null, '52-week low', -20, null]);
  assert.equal(upDown(closes, 120, { ma200: 200.5, low52: 120 }, null, '2026-08-03'), null);   // at the low, no target: nothing to say
  // the score: green ÷ (green + red), facts and "In your depot" left out, groups without a judged point too
  const pts = [{ group: 'price', tone: 'good' }, { group: 'price', tone: 'bad' }, { group: 'price', tone: 'neutral' },
               { group: 'value', tone: 'good' }, { group: 'facts', tone: 'neutral' }, { group: 'facts', tone: 'bad', topic: 'In your depot' }];
  const sc = score(pts, [{ id: 'price', label: 'Price' }, { id: 'value', label: 'Valuation' }, { id: 'facts', label: 'Good to know' }]);
  assert.deepEqual([sc.score, sc.good, sc.bad], [67, 2, 1]);
  assert.deepEqual(sc.groups.map(g => [g.label, g.score]), [['Price', 50], ['Valuation', 100]]);
});

check('gain since bought splits into the price and the currency, adding up to the gain', () => {
  assert.deepEqual(['US0231351067', 'CA64046G1063', 'DE0007164600', 'BTC'].map(homeCurrency), ['USD', 'CAD', 'EUR', null]);
  // two lots of 100 €: at 1,10 $ and 1,00 $ per €, now 1,25 - the dollar fell, it cost money
  const fx = { USD: [['2025-01-02', 1.10], ['2025-06-02', 1.00], ['2026-10-06', 1.25]] };
  const lots = [{ date: '2025-01-04', shares: 1, cost: 10000 }, { date: '2025-06-02', shares: 1, cost: 10000 }];   // a Saturday: Thursday's rate
  const [us, de, btc, none] = currencySplit([
    { key: 'US0000000001', shares: 2, value: 30000, cost: 20000, gain: 10000, lots },
    { key: 'DE0000000001', shares: 2, value: 30000, cost: 20000, gain: 10000, lots },
    { key: 'BTC', shares: 2, value: 15000, cost: 20000, gain: -5000, lots },
    { key: 'US0000000002', value: null }], fx);
  assert.equal(us.fromCurrency, Math.round(15000 * (1 - 1.25 / 1.10) + 15000 * (1 - 1.25)));   // −5.795
  assert.equal(us.fromPrice + us.fromCurrency, 10000);
  assert.equal(us.fxThen.toFixed(4), '1.0500');                         // weighted by cost
  assert.equal(us.fxMove.toFixed(1), '-16.0');                          // 1,05 / 1,25 − 1
  assert.deepEqual([de.fromPrice, de.fromCurrency, btc.fromPrice, btc.fromCurrency], [10000, 0, -5000, 0]);
  assert.equal(none.fromPrice, undefined);                              // no price, no split
  assert.equal(currencySplit([{ key: 'US0000000001', shares: 2, value: 30000, cost: 20000, gain: 10000, lots }], null)[0].fromCurrency, 0);
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
  // losses: on the size of the year before - a smaller loss is up, a bigger one down, a loss to a profit up
  const l = K.table(K.clean({ company: 'X', isin: 'DE0000000001', currency: 'EUR', metrics: [{ id: 'ni', label: 'Net income', unit: 'm' }],
    quarters: [{ period: '2025-Q4', values: { ni: -62.8 } }, { period: '2026-Q4', values: { ni: -61.6 } }] }), {}, { today: '2026-10-07' });
  assert.equal(l.rows[0].cells.at(-1).change.toFixed(1), '1.9');
  const lc = (b, v) => K.table(K.clean({ company: 'X', isin: 'DE0000000001', metrics: [{ id: 'e', label: 'EBIT', unit: 'm' }],
    quarters: [{ period: '2025-Q4', values: { e: b } }, { period: '2026-Q4', values: { e: v } }] }), {}, { today: '2026-10-07' }).rows[0].cells.at(-1).change;
  assert.equal(Math.round(lc(-34.5, -72.1)), -109);
  assert.equal(Math.round(lc(-10, 5)), 150);
  assert.equal(K.table(f, {}, { today: '2026-11-11', nextResults: '2026-11-10' }).due, true);
  assert.throws(() => K.clean({ metrics: [{ id: 'gmv', label: 'GMV', unit: '$bn' }], quarters: [{ period: '2026-2', values: {} }] }));
  // the company's own profit measure: four quarters in a row, per share in euros
  const de = K.clean({ company: 'B', metrics: [{ id: 'de', label: 'DE', unit: '$m', earnings: true }],
    quarters: ['2025-Q3', '2025-Q4', '2026-Q1', '2026-Q2'].map((period, i) => ({ period, values: { de: [1487, 1587, 1550, 1548][i] } })) });
  const own = K.ownMeasure(de, { shares: 2.452e9, fx: { USD: 1.1269 } });
  assert.equal(own.perShare.toFixed(3), '2.234');                       // 6.172 m $ ÷ 1,1269 ÷ 2,452 bn shares
  assert.equal(own.period, 'Q3 2025–Q2 2026');
  assert.equal(K.ownMeasure({ ...de, quarters: de.quarters.filter(q => q.period !== '2025-Q4') }, { shares: 1, fx: { USD: 1 } }), null);
  assert.throws(() => K.clean({ metrics: [{ id: 'a', label: 'A', unit: '$m', earnings: true }, { id: 'b', label: 'B', unit: '$m', earnings: true }] }));
});

check('sector: by onvista\'s industry - an online shop is Consumer, not Technology; a mixed industry keeps onvista\'s sector', () => {
  const co = (name, sector) => ({ branch: { name, sector: { name: sector } } });
  assert.equal(sectorOf(co('Internetkommerz', 'Informationstechnologie')), 'Consumer');
  assert.equal(sectorOf(co('Luft- und Raumfahrtindustrie', 'Transport / Verkehrssektor')), 'Industrials');
  assert.equal(sectorOf(co('Immobilien', 'Diverse')), 'Real estate');
  assert.equal(sectorOf(co('Sonstige Branchen', 'Diverse')), 'Diversified');
  assert.equal(sectorOf(co('Neu', 'Chemie / Pharma / Gesundheit')), 'Health care');
  assert.equal(sectorOf({}), null);
});

check('two share classes: book value and market value over every share, not the listed class only (VW preferred)', () => {
  // 200 preferred listed of 500 shares: equity 175.000 €, 350 € a share over all of them
  const an = { key: 'DE0000000003', name: 'V', type: 'STOCK', isin: 'DE0000000003', notes: [],
               profile: { shares: 200, marketCap: 200 * 777, marketCapCurrency: 'EUR' },
               annual: [{ label: '2025', estimate: false, eps: 13, bookPerShare: 350 }],
               reported: [{ label: '2025', equity: 175000, currency: 'EUR' }] };
  const r = readout({ an, closes: [], quote: { last: 70 }, today: '2026-10-07' });
  assert.equal(r.stats.bookPerShare, 350);                                // not 175.000 / 200 = 875
  assert.equal(r.stats.grahamNumber, Math.sqrt(22.5 * 13 * 350));
  assert.match(r.points.find(p => p.topic === 'Valuation').text, /Market value 35\.000 €/);   // 500 × 70 €
});

check('P/E on the last year reported only: a loss then is no P/E, not an old year\'s (Neo: 2021 after a 2025 loss)', () => {
  const an = { key: 'CA0000000004', name: 'N', type: 'STOCK', isin: 'CA0000000004', notes: [], profile: {},
               annual: [{ label: '2021', estimate: false, eps: 0.81, per: 15.6 }, { label: '2025', estimate: false, eps: -0.21 }] };
  const r = readout({ an, closes: [], quote: { last: 12 }, today: '2026-10-07' });
  assert.equal(r.stats.pe ?? null, null);
  assert.equal(r.points.find(p => p.topic === 'Graham').text.includes('no profit in 2025'), true);
});

check('website: of several, a preferred one, else the shortest named like the company - not a brand\'s', () => {
  const s = (url, preferred = false) => ({ url, preferred });
  assert.equal(pickSite([s('https://www.alamocement.com/'), s('https://www.buzziunicemusa.com/'), s('https://www.buzzi.com'), s('https://www.dyckerhoff.com/')], 'Buzzi'), 'https://www.buzzi.com');
  assert.equal(pickSite([s('https://brand.example/'), s('https://www.group.example/', true)], 'Group'), 'https://www.group.example/');
  assert.equal(pickSite([s('https://investors.on-running.com/home/default.aspx')], 'On Holding'), 'https://investors.on-running.com/home/default.aspx');
  // Micron: country sites and a subdomain - micron.com
  assert.equal(pickSite([s('https://micron.cn'), s('https://micron.com.tw'), s('https://tw.micron.com'), s('https://www.micron.com.jp'), s('https://www.micron.com/')], 'Micron Technology'), 'https://www.micron.com/');
  assert.equal(pickSite([], 'X'), null);
});

check('politicians: US Congress members\' purchases, one row per member, day and amount; no line when none', () => {
  const t = (member, type, date) => ({ member, chamber: 'house', state: 'LA06', type, transaction_date: date, disclosure_date: '2026-10-01', amount_range: '$1,001 - $15,000' });
  const buys = buysOf([t('Cleo Fields', 'purchase', '2026-09-10'), t('Cleo Fields', 'purchase', '2026-09-10'), t('A B', 'sale', '2026-09-12'), t('C D', 'purchase', '2026-09-20')]);
  assert.deepEqual(buys.map(b => b.member), ['C D', 'Cleo Fields']);       // newest first, the twice-filed one once, no sale
  const an = { key: 'US0000000009', name: 'M', type: 'STOCK', isin: 'US0000000009', notes: [], profile: {}, annual: [], congress: buys };
  const p = readout({ an, closes: [], quote: { last: 10 }, today: '2026-10-08' }).points.find(x => x.topic === 'Politicians');
  assert.equal(p.group, 'market');
  assert.equal(p.tone, 'neutral');                                         // a fact: the score does not count it
  assert.equal(p.head, 'C D, Cleo Fields bought');
  assert.match(p.text, /Bargo/);
  assert.equal(readout({ an: { ...an, congress: [] }, closes: [], quote: { last: 10 }, today: '2026-10-08' }).points.some(x => x.topic === 'Politicians'), false);
});

check('currency: the main listing\'s - where most shares trade - not the country of the ISIN', () => {
  const v = (venue, country, currency, volume4w) => ({ venue, country, currency, volume4w });
  // On: Swiss ISIN, only on the NYSE
  assert.deepEqual(mainListing([v('NYSE', 'US', 'USD', 3e7), v('Tradegate', 'DE', 'EUR', 9e3)], 'CH1134540470'), { venue: 'NYSE', currency: 'USD' });
  assert.equal(mainListing([v('London Stock Exchange', 'GB', 'GBp', 2e6), v('Nasdaq OTC', 'US', 'USD', 1e3)], 'GB0003718474').currency, 'GBP');   // pence
  // Neo: more OTC and Tradegate volume than on the one Toronto venue - still Canadian dollars
  assert.equal(mainListing([v('Nasdaq OTC', 'US', 'USD', 1.6e6), v('Tradegate BSX', 'DE', 'EUR', 8.8e4), v('Toronto CNSX', 'CA', 'CAD', 3e4)], 'CA64046G1063').currency, 'CAD');
  // Brookfield: NYSE and Toronto - the larger
  assert.equal(mainListing([v('NYSE', 'US', 'USD', 1.2e8), v('Toronto CNSX', 'CA', 'CAD', 1.3e6)], 'CA11271J1075').currency, 'USD');
  // a German company: Xetra, though it also trades in Zurich
  assert.equal(mainListing([v('Xetra', 'DE', 'EUR', 5e7), v('SIX Swiss Exchange', 'CH', 'CHF', 1e3)], 'DE0007236101').currency, 'EUR');
  assert.equal(mainListing([v('LS Exchange', 'DE', 'EUR', null), v('Toronto', 'CA', 'CAD', null)], 'CA0000000000').currency, 'CAD');   // no volumes
  assert.equal(mainListing([v('Tradegate', 'DE', 'EUR', 5e3)], 'IE0000000000').currency, 'EUR');                          // only in Germany
  assert.equal(mainListing([]), null);
  const fx = { USD: [['2025-01-02', 1.10], ['2026-10-06', 1.25]] };
  const [on] = currencySplit([{ key: 'CH1134540470', shares: 1, value: 10000, cost: 10000, gain: 0, lots: [{ date: '2025-01-02', shares: 1, cost: 10000 }] }],
    fx, () => 'USD');
  assert.equal(on.home, 'USD');
  assert.ok(on.fromCurrency < 0);                                         // the dollar fell: On cost money in euros
});

check('estimates: Yahoo\'s periods, moved on when its dates lag results already out; revenue held against what came out', () => {
  const v = x => ({ raw: x }), at = d => ({ raw: Date.parse(`${d}T00:00:00Z`) / 1000 });
  const t = (period, endDate, eps, rev, ago) => ({ period, endDate,
    earningsEstimate: { avg: v(eps), numberOfAnalysts: v(30), earningsCurrency: 'USD' },
    revenueEstimate: { avg: v(rev), numberOfAnalysts: v(rev ? 33 : 0), yearAgoRevenue: v(ago), revenueCurrency: 'USD' } });
  // Micron after its results of 30 Sep 2026: "this year" still ends Aug 2026, the year just reported
  const q = { earnings: { financialCurrency: 'USD', earningsChart: { quarterly: [
                { periodEndDate: at('2026-05-31'), reportedDate: at('2026-06-25'), actual: v(19), estimate: v(18) },
                { periodEndDate: at('2026-08-31'), reportedDate: at('2026-09-30'), actual: v(33.4), estimate: v(31.8) }] } },
              earningsTrend: { trend: [t('0q', '2026-08-31', 38, 61e9, 13e9), t('+1q', '2026-11-30', 42, 0, 0),
                                       t('0y', '2026-08-31', 176, 275e9, 133e9), t('+1y', '2027-08-31', 206, 319e9, 275e9)] },
              calendarEvents: { earnings: { earningsDate: [at('2026-12-23')], isEarningsDateEstimate: true } } };
  const e = parseEstimates(q, [{ end: '2026-05-28', revenue: 40e9 }]);
  assert.deepEqual(e.years.map(y => y.end), ['2027-08-31', '2028-08-31']);
  assert.deepEqual(e.quarters.map(y => y.end), ['2026-11-30', '2027-02-28']);
  assert.equal(Math.round(e.years[0].revenueGrowth), 107);                        // 275 bn on 133 bn
  assert.equal(e.quarters[1].revenue, null);                                      // Yahoo's 0: no estimate
  assert.equal(e.reported[0].revenue, 40e9);                                      // 28 May for 31 May: the same quarter
  assert.deepEqual(e.next, { date: '2026-12-23', estimated: true });
  assert.deepEqual([fyLabel('2027-08-31'), fyLabel('2026-12-31'), fyLabel('2010-03-31')], ['26/27', '2026', '09/10']);
});

check('estimates: a year is reported once filed, not once ended; Yahoo\'s years replace onvista\'s, one source a figure', () => {
  const rows = () => [{ label: '2025', eps: 0.6 }, { label: '2026', eps: 1.3, dps: 0.1 }, { label: '2027', eps: 1.5 },
                      { label: '2028', estimate: true, eps: 2, dps: 0.2, peg: 0.9 }];
  // On Holding: onvista lists 2026-2028 without an "e"
  assert.deepEqual(markFiled(rows(), { filed: ['2025'] }, '2027-02-10').map(r => !!r.estimate), [false, true, true, true]);
  assert.equal(markFiled(rows(), { through: '2026-12-31' }, '2027-03-05')[1].estimate, undefined);   // Q4 out
  assert.equal(markFiled(rows(), {}, '2027-05-15')[1].estimate, undefined);       // four months on
  const est = { rate: 2, years: [{ label: '2026', end: '2026-12-31', eps: 3, epsAnalysts: 20, revenue: 8e9, revenueAnalysts: 25 },
                                  { label: '2029', end: '2029-12-31', eps: 6, epsAnalysts: 4, revenue: null }] };
  const m = mergeEstimates(markFiled(rows(), { filed: ['2025'] }, '2026-10-08'), est);
  const by = Object.fromEntries(m.map(r => [r.label, r]));
  assert.deepEqual([by['2026'].eps, by['2026'].revenue, by['2026'].source, by['2026'].epsAnalysts, by['2026'].dps], [1.5, 4e9, 'Yahoo', 20, 0.1]);
  assert.deepEqual([by['2028'].eps, by['2028'].peg, by['2028'].dps], [null, null, 0.2]);            // not onvista's EPS for one year
  assert.equal(by['2029'].eps, 3);                                                // a year only Yahoo has: a row
  assert.deepEqual(m.map(r => r.label), ['2025', '2026', '2027', '2028', '2029']);
  assert.equal(mergeEstimates(rows(), { ...est, rate: null })[1].eps, 1.3);       // no exchange rate: onvista's stay
});

check('estimates: the read-out names the source and the analysts, judges results against the estimate, says what is due', () => {
  const an = { key: 'DE0000000002', name: 'Y', type: 'STOCK', isin: 'DE0000000002', notes: [],
               profile: { marketCap: 1000, marketCapCurrency: 'EUR', shares: 100 },
               annual: [{ label: '2024', eps: 0.8 }, { label: '2025', eps: 1 },
                        { label: '2026', estimate: true, eps: 1.2, end: '2026-12-31', source: 'Yahoo', epsAnalysts: 2 },
                        { label: '2027', estimate: true, eps: 1.5, end: '2027-12-31', source: 'Yahoo', epsAnalysts: 2 }],
               estimates: { source: 'Yahoo', currency: 'EUR', rate: 1,
                 years: [{ label: '2026', end: '2026-12-31', revenue: 350e6, revenueGrowth: 22.7, revenueAnalysts: 2 }],
                 quarters: [{ end: '2026-09-30', eps: 0.3, epsAnalysts: 2, revenue: 90e6, revenueAnalysts: 2, revenueGrowth: 10 }],
                 reported: [{ end: '2025-12-31', eps: 0.2, epsEstimate: 0.25 }, { end: '2026-03-31', eps: 0.3, epsEstimate: 0.25 },
                            { end: '2026-06-30', eps: 0.2, epsEstimate: 0.3, revenue: 95e6, revenueEstimate: 100e6 }],
                 next: { date: '2026-11-12', estimated: false } } };
  const r = readout({ an, closes: [], quote: { last: 12 }, today: '2026-10-08', rates: { date: '2026-10-07', bond10y: 3.5, fx: {} } });
  const pt = Object.fromEntries(r.points.map(p => [p.topic, p]));
  assert.match(pt.Outlook.text, /1,20 € \(2026\), 1,50 € \(2027\) - Yahoo, 2 analysts/);
  assert.match(pt.Outlook.text, /Revenue expected: 350 m € \(2026, \+23 %\) - Yahoo, 2 analysts/);
  assert.equal(pt.Outlook.tone, 'neutral');                                       // 2 analysts: not judged
  assert.match(pt.Valuation.text, /on the next 12 months \(Yahoo, 2 analysts\)/);
  assert.equal(pt.Results.tone, 'bad');                                           // missed 2 of 3
  assert.match(pt.Results.text, /Jun 2026 95 m € vs 100 m \(−5 %\)/);
  assert.match(pt['Next results'].text, /^12 Nov 2026, in 35 days\. Analysts expect EPS 0,30 € and revenue 90 m € \(\+10 % on a year before\) for the quarter to 30 Sept 2026/);
  const q = results(an.estimates);
  assert.deepEqual([q.beats, q.misses, q.judged, Math.round(q.list[2].revenueSurprise)], [1, 2, 3, -5]);
});

check('research: the stage - revenue growing, a profit, money paid back - and the two yardsticks that fit it', () => {
  // a loss smaller than the year before, revenue expected up: hyper growth, on sales - next 12 months of 2026 and 2027
  const an = { key: 'CA0000000009', name: 'G', type: 'STOCK', isin: 'CA0000000009', notes: [],
               profile: { marketCap: 1000, marketCapCurrency: 'EUR', shares: 100 },
               annual: [{ label: '2024', estimate: false, eps: -0.2 }, { label: '2025', estimate: false, eps: -0.1 }],
               cashflow: { currency: 'USD', years: [{ year: '2024', end: '2024-12-31', netIncome: -20, free: -5 },
                                                    { year: '2025', end: '2025-12-31', netIncome: -10, free: -2, dividendsPaid: -5 }] },
               estimates: { currency: 'USD', years: [{ label: '2026', end: '2026-12-31', revenue: 400, revenueGrowth: 40, revenueAnalysts: 4 },
                                                     { label: '2027', end: '2027-12-31', revenue: 600 }] } };
  const at = (a, last) => readout({ an: a, closes: [], quote: { last }, today: '2026-10-07', rates: { fx: { EUR: 1, USD: 1.2 } } });
  const st = r => r.points.find(p => p.topic === 'Stage');
  const g = at(an, 10);
  assert.equal(st(g).head, '2 Hyper growth · fwd P/S 2,2 · P/GP –');   // 1.200 $ ÷ (23 % × 400 + 77 % × 600)
  assert.match(st(g).text, /loss 10 \$ in 2025, smaller than in 2024; pays 0,4 % of its market value back a year \(dividend 0,4 %\) despite the loss - a token\./);
  assert.equal(g.points.findIndex(p => p.topic === 'Stage'), g.points.findIndex(p => p.group === 'value'));   // first in Valuation
  // a profit and 5 % paid out: capital return, on the last year's P/E
  const pay = { ...an, cashflow: undefined, estimates: undefined,
                annual: [{ label: '2024', estimate: false, eps: 1, revenue: 900, netIncome: 90, dps: 0.2 },
                         { label: '2025', estimate: false, eps: 1.2, revenue: 1000, netIncome: 120, dps: 0.5 }, { label: '2026', estimate: true, eps: 1.5 }] };
  assert.equal(st(at(pay, 10)).head, '4 Capital return · P/E 8 · P/FCF –');
  // a token dividend is no stage: operating leverage, on P/E ahead
  assert.equal(st(at(pay, 100)).head, '3 Operating leverage · fwd P/E 67 · P/FCF –');
  // revenue down and analysts expect it down again: decline
  const down = { ...pay, annual: [pay.annual[0], { ...pay.annual[1], revenue: 800 }, pay.annual[2]],
                 estimates: { currency: 'EUR', years: [{ label: '2026', end: '2026-12-31', revenue: 760, revenueGrowth: -5 }] } };
  assert.match(st(at(down, 10)).head, /^5 Decline · fwd P\/E 7 · /);
});

check('the MCP server and the web server parse', () => {
  // a stray quote in a tool description stops the MCP server from starting at all
  for (const f of ['mcp.mjs', 'server.mjs']) execFileSync(process.execPath, ['--check', path.join(HERE, '..', f)], { stdio: 'pipe' });
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
