/**
 * A read-out for one stock, made from the numbers - no model, no opinion. The same data
 * always gives the same text. Each point has a tone (good / bad / neutral) by a fixed rule,
 * written next to it, so the reader can see why it is green or red.
 *
 *   readout({ an, closes, quote, news, depot, amount, today, names })
 *     an       analysis(key) - onvista + Nasdaq + FINRA
 *     closes   [[YYYY-MM-DD, close EUR], ...] ascending, a year or more
 *     quote    { last, prev } EUR now
 *     news     headlines for this stock, last 7 days, with .story
 *     depot    { positions: [{ key, name, value (cents), country }], cash (cents) } or null
 *     amount   euros you think of buying, 0 for none
 *     names    words a headline must contain to count for a theme ("Sea", "SE"), case-sensitive
 *   -> { points: [{ topic, tone, text, rule }], fit, themes, stats }
 *
 *   peHistory(an, closes, last)     price/earnings by day, against the stock's own past
 *   fitIn(depot, an, amount)        weights, position / sector / country mix before / after buying `amount` euros
 *   depotPoint(fit, an, amount)     the read-out's "In your depot" point for that, or null
 *   (no imports: the page loads this file too, so the slider recomputes without asking the server)
 *
 *   themes(news, names)   what the headlines are about: insider sales, up/downgrades, beats/misses, legal
 *   naming(names)         title -> does it name the company? (whole word, case-sensitive)
 */
const nf = (min, max) => new Intl.NumberFormat('de-DE', { minimumFractionDigits: min, maximumFractionDigits: max });
const n0 = v => nf(0, 0).format(v), n1 = v => nf(0, 1).format(v), n2 = v => nf(2, 2).format(v);
const pct = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${n0(Math.abs(v))} %`;
const big = v => {
  const a = Math.abs(v), [d, u] = a >= 1e12 ? [1e12, ' tn'] : a >= 1e9 ? [1e9, ' bn'] : a >= 1e6 ? [1e6, ' m'] : [1, ''];
  return `${n1(v / d)}${u}`;
};
const cur = c => (c === 'USD' ? '$' : '€');
const growth = (a, b) => (a != null && b ? (a / b - 1) * 100 : null);
const day = s => new Date(s + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

// ------------------------------------------------------------ headlines -> themes
const THEMES = [
  { id: 'insider', label: 'insider sales', tone: 'bad', re: /\binsiders?\b.*\b(sells?|sold|sale|sales)\b|\b(sells?|sold)\b.*\bshares\b.*\binsider|\bunder a trading plan\b/i },
  { id: 'downgrade', label: 'downgrades', tone: 'bad', re: /\bdowngrad/i },
  { id: 'miss', label: 'missed estimates', tone: 'bad', re: /\bmiss(es|ed)?\b|\bbelow (estimates|expectations)\b|\bfalls? short\b/i },
  { id: 'legal', label: 'legal / regulators', tone: 'bad', re: /\blawsuit|\bclass action|\bprobe\b|\binvestigation\b|\bregulator|\bfined?\b|\bsued\b|\bantitrust/i },
  { id: 'upgrade', label: 'upgrades', tone: 'good', re: /\bupgrad/i },
  { id: 'beat', label: 'beat estimates', tone: 'good', re: /\bbeats?\b|\btops? (estimates|expectations)\b|\babove (estimates|expectations)\b/i },
  { id: 'buyback', label: 'buybacks', tone: 'good', re: /\bbuy-?backs?\b|\brepurchase/i },
  { id: 'target', label: 'price targets', tone: 'neutral', re: /\bprice target/i },
];

/**
 * One count per story, not per outlet: a story that 20 sites ran is still one insider sale.
 * Only headlines that name the company count - a keyword search also returns articles that
 * merely mention it ("Holland America ... upgrades").
 */
export function naming(names = []) {
  const ok = names.filter(Boolean).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = ok.length ? new RegExp(`\\b(${ok.join('|')})\\b`) : null;
  return title => !re || re.test(title);
}

export function themes(news, names = []) {
  const about = naming(names), byStory = new Map();
  for (const i of news) if (about(i.title) && !byStory.has(i.story ?? i.link)) byStory.set(i.story ?? i.link, i);
  return THEMES.map(t => {
    const hits = [...byStory.values()].filter(i => t.re.test(i.title));
    return { id: t.id, label: t.label, tone: t.tone, stories: hits.length, example: hits[0] ? { title: hits[0].title, link: hits[0].link, source: hits[0].source } : null };
  }).filter(t => t.stories);
}

// ------------------------------------------------------------ the read-out
/** The read-out in five groups, in this order; a topic not listed goes to the last. */
export const GROUPS = [
  { id: 'price', label: 'Price', topics: ['Price', 'Trend', 'Swings'] },
  { id: 'business', label: 'Business', topics: ['Growth', 'Profit', 'Returns', 'Cash flow', 'Balance sheet', 'Company numbers', 'Data'] },
  { id: 'value', label: 'Valuation', topics: ['Valuation', 'Graham', 'Buffett', 'Lynch', 'Ackman'] },
  { id: 'market', label: "Who's buying", topics: ['Analysts', 'Insiders', 'Short interest', 'Funds', 'News'] },
  { id: 'facts', label: 'Good to know', topics: ['Next results', 'Dividend', 'Listing', 'In your depot'] },
];
export const groupOf = topic => (GROUPS.find(g => g.topics.includes(topic)) ?? GROUPS.at(-1)).id;

/**
 * Each point: topic, tone, head (the one number to read at a glance), text (the full sentence),
 * rule (why the colour), checks ([{ label, ok }] for an investor's list), group.
 */
export function readout({ an, closes = [], quote, news = [], depot = null, amount = 0, today, names = [] }) {
  const points = [];
  const add = (topic, tone, text, rule, head = null, checks = null) =>
    points.push({ topic, group: groupOf(topic), tone, head, text, rule, ...(checks ? { checks } : {}) });
  const us = an.us, last = quote?.last ?? closes.at(-1)?.[1] ?? null;
  const stats = {}, pe = peHistory(an, closes, last);

  // price: the last year in EUR, on the same venue as the live price
  if (last != null && closes.length > 20) {
    const ago = days => { const d = new Date(Date.parse(today) - days * 864e5).toISOString().slice(0, 10);
                          const p = closes.filter(([x]) => x <= d).at(-1); return p ? p[1] : null; };
    const year = closes.filter(([x]) => x >= new Date(Date.parse(today) - 365 * 864e5).toISOString().slice(0, 10)).map(([, v]) => v);
    const hi = Math.max(...year, last), lo = Math.min(...year, last);
    Object.assign(stats, { last, high52: hi, low52: lo, fromHigh: (last / hi - 1) * 100, fromLow: (last / lo - 1) * 100,
                           m6: growth(last, ago(183)), y1: growth(last, ago(365)) });
    const tone = stats.y1 == null ? 'neutral' : stats.y1 <= -20 ? 'bad' : stats.y1 >= 20 ? 'good' : 'neutral';
    add('Price', tone,
      `${n2(last)} € · ${n0(Math.abs(stats.fromHigh))} % below its 52-week high (${n2(hi)} €), ${n0(stats.fromLow)} % above the low (${n2(lo)} €).`
      + `${stats.y1 != null ? ` 1 year ${pct(stats.y1)}` : ''}${stats.m6 != null ? `, 6 months ${pct(stats.m6)}` : ''}.`,
      'green: 1 year +20 % or more · red: −20 % or worse',
      `${stats.y1 != null ? `1 year ${pct(stats.y1)} · ` : ''}${pct(stats.fromHigh)} from high`);
  }

  // trend: the price against its 50- and 200-day averages, this year so far
  if (last != null && closes.length >= 50) {
    const avg = n => (closes.length >= n ? closes.slice(-n).reduce((s, [, v]) => s + v, 0) / n : null);
    const ma50 = avg(50), ma200 = avg(200), jan = closes.filter(([x]) => x < `${today.slice(0, 4)}-01-01`).at(-1)?.[1];
    Object.assign(stats, { ma50, ma200, ytd: growth(last, jan) });
    const vs = [ma50, ma200].filter(v => v != null), above = vs.filter(v => last > v).length;
    const side = v => (last > v ? 'above' : 'below');
    add('Trend', above === vs.length ? 'good' : above === 0 ? 'bad' : 'neutral',
      `${pct(growth(last, ma50))} against its 50-day average (${n2(ma50)} €)${ma200 != null ? `, ${pct(growth(last, ma200))} against the 200-day (${n2(ma200)} €)` : ''}.`
      + `${stats.ytd != null ? ` This year ${pct(stats.ytd)}.` : ''}`,
      'green: above its 50- and 200-day averages · red: below both',
      ma200 == null ? `${side(ma50)} 50-day average` : side(ma50) === side(ma200) ? `${side(ma50)} 50- and 200-day average`
                    : `${side(ma50)} 50-day, ${side(ma200)} 200-day`);
  }

  // swings: beta against onvista's benchmark index
  const rk = an.risk;
  if (rk?.beta != null) {
    Object.assign(stats, { beta: rk.beta, volatility: rk.volatility });
    add('Swings', 'neutral',
      `Beta ${n2(rk.beta)} against the ${rk.benchmark ?? 'index'} over 250 days: when the index moved 1 %, it moved ${n2(rk.beta)} % on average.`
      + `${rk.volatility != null ? ` Volatility ${n0(rk.volatility)} % a year.` : ''}`, '', `beta ${n2(rk.beta)}`);
  }

  // financials: Nasdaq's reported years (USD) when there are any - onvista can lag a year or two
  const yrs = us?.years?.length >= 2
    ? us.years.map(y => ({ label: y.period.slice(0, 4), revenue: y.revenue, netIncome: y.netIncome, c: 'USD' }))
    : an.annual.filter(r => !r.estimate && r.revenue != null).map(r => ({ label: r.label, revenue: r.revenue, netIncome: r.netIncome, c: 'EUR' }));
  if (yrs.length >= 2) {
    const [b, a] = yrs.slice(-2), first = yrs.at(-4) ?? yrs[0], span = yrs.length - 1 - yrs.indexOf(first);
    const g = growth(a.revenue, b.revenue), cagr = span >= 2 && first.revenue > 0 ? ((a.revenue / first.revenue) ** (1 / span) - 1) * 100 : null;
    Object.assign(stats, { revenueYear: a.label, revenue: a.revenue, revenueGrowth: g, revenueCagr: cagr, currency: a.c });
    add('Growth', g == null ? 'neutral' : g >= 15 ? 'good' : g < 0 ? 'bad' : 'neutral',
      `Revenue ${a.label}: ${big(a.revenue)} ${cur(a.c)} (${pct(g)} on ${b.label})${cagr != null ? `; ${pct(cagr)} a year over ${span} years` : ''}.`,
      'green: revenue +15 % or more · red: shrinking', `revenue ${pct(g)}`);

    if (a.netIncome != null) {
      const margin = a.revenue ? a.netIncome / a.revenue * 100 : null;
      const lossYears = yrs.filter(y => y.netIncome < 0).map(y => y.label);
      const since = a.netIncome > 0 && lossYears.length ? yrs.find(y => y.label > lossYears.at(-1))?.label : null;
      stats.netIncome = a.netIncome; stats.margin = margin;
      add('Profit', a.netIncome < 0 ? 'bad' : b.netIncome != null && a.netIncome > b.netIncome ? 'good' : 'neutral',
        a.netIncome < 0
          ? `Loss ${a.label}: ${big(a.netIncome)} ${cur(a.c)}${b.netIncome != null ? ` (${b.label}: ${big(b.netIncome)})` : ''}.`
          : `Net income ${a.label}: ${big(a.netIncome)} ${cur(a.c)}, ${n1(margin)} % of revenue${b.netIncome != null ? `, ${b.label}: ${big(b.netIncome)}` : ''}.`
            + `${since ? ` Profitable since ${since}, losses before.` : ''}`,
        'green: profit grew · red: a loss',
        a.netIncome < 0 ? `loss ${big(a.netIncome)} ${cur(a.c)}` : `${big(a.netIncome)} ${cur(a.c)} · ${n1(margin)} % margin`);
    }
    if (yrs.at(-1).c === 'EUR' && Number(yrs.at(-1).label.slice(0, 4)) < Number(today.slice(0, 4)) - 1) {
      add('Data', 'neutral', `The financials end in ${yrs.at(-1).label} (onvista) - newer years are missing here.`, '');
    }
  }

  // returns, cash flow, balance sheet: Nasdaq's last reported year (USD), else onvista's ratios
  const mcapUsd = us?.market?.marketCap, priceUsd = us?.price;
  const ly = us?.years?.at(-1), py = us?.years?.at(-2), lyl = ly?.period.slice(0, 4);
  const ov = an.annual.filter(r => !r.estimate).at(-1);
  if (ly?.equity && ly.netIncome != null) {
    const roe = ly.netIncome / ly.equity * 100, roa = ly.totalAssets ? ly.netIncome / ly.totalAssets * 100 : null;
    const gm = ly.grossProfit != null ? ly.grossProfit / ly.revenue * 100 : null, om = ly.operatingIncome != null ? ly.operatingIncome / ly.revenue * 100 : null;
    Object.assign(stats, { roe, roa, grossMargin: gm, operatingMargin: om });
    add('Returns', ly.equity < 0 || roe < 0 ? 'bad' : roe >= 15 ? 'good' : 'neutral',
      `${lyl}: ${n1(roe)} % return on equity${roa != null ? `, ${n1(roa)} % on assets` : ''}.`
      + `${gm != null && om != null ? ` Of 100 $ revenue, ${n0(gm)} $ gross profit and ${n1(om)} $ operating profit.` : ''}`,
      'green: return on equity 15 % or more · red: negative', `ROE ${n1(roe)} %`);
  } else if (ov?.roe != null) {
    stats.roe = ov.roe;
    add('Returns', ov.roe < 0 ? 'bad' : ov.roe >= 15 ? 'good' : 'neutral',
      `${ov.label}: ${n1(ov.roe)} % return on equity${ov.ebitMargin != null ? `, ${n1(ov.ebitMargin)} % operating margin` : ''} (onvista).`,
      'green: return on equity 15 % or more · red: negative', `ROE ${n1(ov.roe)} %`);
  }

  if (ly?.operatingCashFlow != null) {
    const free = y => (y?.operatingCashFlow != null ? y.operatingCashFlow + (y.capex ?? 0) : null);   // capex is negative
    const fcf = free(ly), pf = free(py), st = ly.stock;
    Object.assign(stats, { operatingCashFlow: ly.operatingCashFlow, freeCashFlow: fcf, fcfYield: mcapUsd ? fcf / mcapUsd * 100 : null });
    add('Cash flow', fcf < 0 ? 'bad' : pf != null && fcf > pf ? 'good' : 'neutral',
      `${lyl}: ${big(ly.operatingCashFlow)} $ from operations, ${big(-(ly.capex ?? 0))} $ invested - ${big(fcf)} $ free cash flow`
      + `${pf != null ? ` (${py.period.slice(0, 4)}: ${big(pf)})` : ''}${stats.fcfYield != null ? `, ${n1(stats.fcfYield)} % of the market value` : ''}.`
      + `${st ? st < 0 ? ` Bought back shares for ${big(-st)} $.` : ` No buyback: ${big(st)} $ came in from new shares.` : ''}`,
      'green: free cash flow positive and higher than the year before · red: negative', `free ${big(fcf)} $`);
  } else if (ov?.cashflow != null) {
    add('Cash flow', ov.cashflow < 0 ? 'bad' : 'neutral',
      `${ov.label}: ${big(ov.cashflow)} € cash flow${ov.pcf != null ? `, the price is ${n0(ov.pcf)}× that` : ''} (onvista).`, 'red: negative', `${big(ov.cashflow)} €`);
  }

  if (ly?.equity != null && ly.totalAssets) {
    const cash = (ly.cash ?? 0) + (ly.shortInvestments ?? 0), debt = (ly.shortDebt ?? 0) + (ly.longDebt ?? 0), net = cash - debt;
    const cr = ly.currentAssets && ly.currentLiabilities ? ly.currentAssets / ly.currentLiabilities : null;
    Object.assign(stats, { cash, debt, netCash: net, currentRatio: cr, debtToEquity: ly.equity > 0 ? debt / ly.equity : null });
    add('Balance sheet', ly.equity <= 0 || (cr != null && cr < 1) ? 'bad' : net >= 0 ? 'good' : 'neutral',
      `End of ${lyl}: ${big(cash)} $ cash and short-term investments, ${big(debt)} $ debt${ly.shortDebt ? ` (${big(ly.shortDebt)} due within a year)` : ''}`
      + ` - ${net >= 0 ? `net cash ${big(net)} $` : `net debt ${big(-net)} $`}.`
      + `${cr != null ? ` Current assets cover ${n1(cr)}× what is due within a year.` : ''}`
      + `${stats.debtToEquity != null ? ` Debt is ${n2(stats.debtToEquity)}× equity.` : ''}`,
      'green: more cash than debt · red: less in current assets than is due within a year, or no equity left',
      net >= 0 ? `net cash ${big(net)} $` : `net debt ${big(-net)} $`);
  } else if (ov?.equityRatio != null) {
    add('Balance sheet', 'neutral', `${ov.label}: equity is ${n0(ov.equityRatio)} % of the balance sheet (onvista).`, '', `equity ${n0(ov.equityRatio)} %`);
  }

  // valuation: what one year of profit and of sales costs
  if (mcapUsd || an.profile?.marketCap) {
    const parts = [];
    const lastY = us?.years?.at(-1);
    if (mcapUsd && lastY?.netIncome > 0) { stats.pe = mcapUsd / lastY.netIncome; parts.push(`price/earnings ${n0(stats.pe)} on ${lastY.period.slice(0, 4)} profit`); }
    else if (!us?.years) { const per = an.annual.filter(r => !r.estimate && r.per).at(-1); if (per) { stats.pe = per.per; parts.push(`price/earnings ${n0(per.per)} (${per.label}, onvista)`); } }
    const fwd = (us?.epsForecast || []).filter(f => f.eps > 0).slice(0, 2);
    if (priceUsd && fwd.length) {
      stats.forwardPe = fwd.map(f => ({ year: f.year, pe: priceUsd / f.eps, analysts: f.analysts }));
      parts.push(`${stats.forwardPe.map(f => `${n0(f.pe)} on ${f.year} estimates`).join(', ')} (${fwd[0].analysts ?? '?'} analysts)`);
    }
    if (mcapUsd && lastY?.revenue) { stats.ps = mcapUsd / lastY.revenue; parts.push(`price/sales ${n1(stats.ps)}`); }
    if (mcapUsd && lastY?.equity > 0) { stats.pb = mcapUsd / lastY.equity; parts.push(`price/book ${n1(stats.pb)}`); }
    else if (!us?.years && ov?.pb) { stats.pb = ov.pb; parts.push(`price/book ${n1(ov.pb)}`); }
    // PEG: P/E divided by the expected yearly earnings growth - near 1 means the price matches the growth
    const peg = us?.peg?.value ?? an.annual.find(r => r.estimate && r.peg != null)?.peg ?? null;
    if (peg != null) { stats.peg = peg; parts.push(`PEG ${n2(peg)}`); }
    const eg = us?.peg?.growth ?? [];
    const mc = mcapUsd ? `${big(mcapUsd)} $` : `${big(an.profile.marketCap)} ${cur(an.profile.marketCapCurrency)}`;
    if (pe) stats.peMedian = pe.median;
    add('Valuation', lastY?.netIncome < 0 ? 'bad' : 'neutral',
      `Market value ${mc}${parts.length ? `; ${parts.join('; ')}` : ''}.`
      + `${eg.length ? ` Analysts expect earnings per share ${eg.map(g => `${pct(g.pct)} in ${g.year}`).join(', ')}.` : ''}`
      + `${pe ? ` Against its own past: P/E ${pe.now != null ? n0(pe.now) : 'over 100'} now, ${n0(pe.median)} in the middle since ${day(pe.since)} (yearly profit${pe.nasdaq.length ? `, ${pe.nasdaq.join(', ')} from Nasdaq` : ''}).` : ''}`,
      'red: no profit to measure against · otherwise not judged - compare with peers. PEG = P/E ÷ expected earnings growth: near 1, the price matches the growth',
      stats.pe != null ? `P/E ${n0(stats.pe)}${stats.forwardPe?.length ? ` · ${n0(stats.forwardPe[0].pe)} on ${stats.forwardPe[0].year}` : ''}` : `worth ${mc}`);
  }

  // three investors' tests, by their published rules; per share, in the listing's currency
  const shares = (mcapUsd && priceUsd ? mcapUsd / priceUsd : null) || an.profile?.shares || null;
  investors(an, { ly, last, priceUsd, shares, stats, add, today });

  // analysts (US-listed only)
  const at = us?.analysts;
  if (at) {
    const n = at.buy + at.hold + at.sell;
    add('Analysts', at.upside >= 15 && at.buy > n / 2 ? 'good' : at.upside < 0 || at.sell > at.buy ? 'bad' : 'neutral',
      `${at.buy} buy, ${at.hold} hold, ${at.sell} sell. Average target ${n2(at.target)} $ (${pct(at.upside)} vs ${n2(at.price)} $), range ${n0(at.low)}–${n0(at.high)} $.`,
      'green: most say buy and the target is 15 % or more above · red: target below the price or more sells than buys',
      `${at.buy} of ${n} buy · target ${pct(at.upside)}`);
  }

  // who buys and sells: insiders, short sellers, funds (US-listed only)
  const ins = us?.insiders;
  if (ins) {
    const { buys, sells, sold, bought } = ins.m3, planned = ins.recent.filter(t => /automatic/i.test(t.type)).length;
    Object.assign(stats, { insiderSells3m: sells, insiderBuys3m: buys, insiderNetShares3m: bought - sold });
    add('Insiders', buys > sells ? 'good' : sells > 0 && !buys ? 'bad' : 'neutral',
      (buys + sells
        ? `Last 3 months: ${sells} sales, ${buys} buys${sold ? `; ${big(sold)} shares sold${shares ? ` (${n2(sold / shares * 100)} % of all shares${priceUsd ? `, ≈ ${big(sold * priceUsd)} $ at today's price` : ''})` : ''}` : ''}.`
        : 'No insider trades in the last 3 months.')
      + ` 12 months: ${ins.m12.sells} sales, ${ins.m12.buys} buys.`
      + `${ins.recent.length ? ` ${planned} of the latest ${ins.recent.length} under a pre-set trading plan.` : ''}`,
      'green: insiders bought more often than they sold (3 months) · red: they sold and did not buy. Sales under a pre-set plan say less than a buy',
      `${sells} sold, ${buys} bought · 3 months`);
  }
  const si = us?.shortInterest;
  if (si?.shares != null) {
    const p = shares ? si.shares / shares * 100 : null;
    Object.assign(stats, { shortPct: p, daysToCover: si.daysToCover });
    add('Short interest', p == null ? 'neutral' : p >= 10 ? 'bad' : p < 5 ? 'good' : 'neutral',
      `${big(si.shares)} shares sold short on ${day(si.date)}${p != null ? `, ${n1(p)} % of all shares` : ''}`
      + `${si.daysToCover != null ? `: ${n1(si.daysToCover)} days of average trading to buy them back` : ''}.`
      + `${si.changePct == null ? '' : Math.abs(si.changePct) < 0.5 ? ' About the same as the report before.' : ` ${pct(si.changePct)} on the report before.`}`,
      'green: under 5 % of the shares sold short · red: 10 % or more - short sellers bet on a fall',
      p != null ? `${n1(p)} % of shares` : `${big(si.shares)} shares`);
  }
  // Nasdaq's own % counts against ordinary shares - wrong for an ADR worth several (1 PDD ADS = 4) - so: their shares / ours
  const io = us?.institutions;
  if (io?.pct != null || io?.shares) {
    const held = io.shares && shares ? io.shares / shares * 100 : io.pct;
    stats.institutionsPct = held;
    add('Funds', io.increased > io.decreased ? 'good' : io.decreased > io.increased ? 'bad' : 'neutral',
      `${n0(held)} % of the shares held by ${n0(io.holders)} funds and institutions.`
      + ` Last quarter${io.asOf ? ` (to ${day(io.asOf)})` : ''}: ${io.increased} added, ${io.decreased} cut, ${io.newHolders} new, ${io.soldOut} sold out.`
      + `${io.top.length ? ` Largest: ${io.top.slice(0, 3).map(t => `${t.name} (${pct(t.changePct)})`).join(', ')}.` : ''}`,
      'green: more funds added than cut last quarter · red: more cut than added. From quarterly filings, up to 45 days late',
      `${io.increased} added, ${io.decreased} cut`);
  }

  // what comes next
  if (us?.earningsDate && us.earningsDate >= today) {
    const days = Math.round((Date.parse(us.earningsDate) - Date.parse(today)) / 864e5);
    add('Next results', 'neutral', `${day(us.earningsDate)}, in ${days} days. The price often jumps on results day, both ways.`, '', `${day(us.earningsDate)} · in ${days} days`);
  }

  // news, last 7 days
  const th = themes(news, names);
  if (news.length) {
    const stories = new Set(news.map(i => i.story ?? i.link)).size, outlets = new Set(news.map(i => i.source)).size;
    const bad = th.filter(t => t.tone === 'bad').reduce((s, t) => s + t.stories, 0), good = th.filter(t => t.tone === 'good').reduce((s, t) => s + t.stories, 0);
    add('News', bad > good ? 'bad' : good > bad ? 'good' : 'neutral',
      `${news.length} headlines, ${stories} stories, ${outlets} outlets in 7 days.${th.length ? ` About: ${th.map(t => `${t.label} (${t.stories})`).join(', ')}.` : ''}`,
      'green / red: more stories about upgrades, beats, buybacks than about insider sales, downgrades, misses, legal - or the other way',
      th.length ? th.slice(0, 2).map(t => `${t.label} ${t.stories}`).join(' · ') : `${stories} stories`);
  }

  // dividend and currency
  const dps = an.annual.filter(r => !r.estimate && r.dps != null).at(-1);
  if (an.type === 'STOCK') add('Dividend', 'neutral', dps?.dps ? `${n2(dps.dps)} € a share (${dps.label}), yield ${n1(dps.divYield ?? 0)} %.` : 'No dividend: the company keeps its profit.', '',
                                dps?.dps ? `${n1(dps.divYield ?? 0)} % yield` : 'none');
  if (an.isin?.startsWith('US') && an.profile?.country && an.profile.country !== 'USA') {
    add('Listing', 'neutral', `A US-listed share (ADR) of a company from ${an.profile.country}. It trades in dollars: in euros your result also moves with EUR/USD.`, '', 'ADR in US dollars');
  } else if (an.isin?.startsWith('US')) {
    add('Listing', 'neutral', 'Trades in dollars: in euros your result also moves with EUR/USD.', '', 'in US dollars');
  }

  const fit = depot ? fitIn(depot, an, amount) : null;
  const dp = fit && depotPoint(fit, an, amount);
  if (dp) points.push(dp);
  return { points, groups: GROUPS, fit, themes: th, stats, pe };
}

/**
 * Price/earnings by day: how expensive the stock is against its own past. Market value that day
 * (the price × today's share count) ÷ net income, blended in a straight line between two year
 * ends (about the last twelve months); after the last reported year it stays at that year, so
 * today's value is the read-out's P/E. Net income, not onvista's EPS: that switches between
 * share and ADS within one company's history. No P/E in or just after a loss year, nor above 100.
 *   -> { dates, values, median, now, since, basis } or null; at most ~520 points
 */
export function peHistory(an, closes, last) {
  // US-listed: Nasdaq's share count (onvista's can miss ADS issued since); else onvista's market value
  const mcapUsd = an.us?.market?.marketCap, priceUsd = an.us?.price;
  const shares = mcapUsd && priceUsd ? mcapUsd / priceUsd : an.profile?.marketCap && last ? an.profile.marketCap / last : null;
  // a fiscal year '24/25' ends somewhere in 2025: taken as 30 June
  const end = l => (/^\d{4}$/.test(l) ? `${l}-12-31` : /^\d{2}\/\d{2}$/.test(l) ? `20${l.slice(3)}-06-30` : null);
  const yrs = an.annual.filter(r => !r.estimate && r.netIncome != null && end(r.label)).map(r => ({ label: r.label, netIncome: r.netIncome, end: end(r.label) }));
  // years onvista does not have yet (Sea: it stops at 2023) from Nasdaq, in euros at today's rate
  if (priceUsd && last) for (const y of an.us?.years ?? []) {
    if (y.netIncome != null && y.period.slice(0, 4) > (yrs.at(-1)?.end ?? '').slice(0, 4)) yrs.push({ label: y.period.slice(0, 4), netIncome: y.netIncome * last / priceUsd, end: y.period, nasdaq: true });
  }
  if (!shares || !yrs.length || closes.length < 20) return null;
  const incomeAt = d => {
    const i = yrs.findLastIndex(y => y.end <= d);
    if (i < 0) return null;
    const a = yrs[i], b = yrs[i + 1];
    if (!b || a.netIncome <= 0) return a.netIncome;                // no blend out of a loss: break-even is no P/E
    const f = (Date.parse(d) - Date.parse(a.end)) / (Date.parse(b.end) - Date.parse(a.end));
    return a.netIncome + (b.netIncome - a.netIncome) * f;
  };
  const peAt = (d, p) => { const ni = incomeAt(d), pe = ni > 0 ? p * shares / ni : null; return pe != null && pe <= 100 ? pe : null; };
  const step = Math.ceil(closes.length / 520);
  const pts = closes.filter((_, i) => i % step === 0 || i === closes.length - 1).map(([d, p]) => [d, peAt(d, p)]);
  const from = pts.findIndex(([, v]) => v != null);
  if (from < 0) return null;
  const shown = pts.slice(from), vals = shown.map(([, v]) => v).filter(v => v != null).sort((x, y) => x - y);
  return { dates: shown.map(([d]) => d), values: shown.map(([, v]) => v), median: vals[Math.floor(vals.length / 2)],
           now: peAt('9999-12-31', last), since: shown[0][0], basis: yrs.at(-1).label, nasdaq: yrs.filter(y => y.nasdaq).map(y => y.label) };
}

/**
 * Graham, Buffett, Lynch, Ackman - each by the rule they wrote down, on the last reported year.
 *   Graham   (The Intelligent Investor): pay at most √(22,5 × EPS × book value per share), i.e.
 *            P/E 15 × P/B 1,5; plus his defensive checks that our data covers
 *   Buffett  published no formula: the checks commonly drawn from his letters - return on equity,
 *            gross margin (pricing power), debt payable from a few years of profit, steady profit and cash
 *   Lynch    (One Up on Wall Street): (earnings growth + dividend yield) ÷ P/E - under 1 poor,
 *            1,5 okay, 2 or more what he looked for. Growth: analysts' EPS estimates, a year
 *   Ackman   Pershing Square's stated criteria, the measurable ones: free-cash-flow generative,
 *            predictable (revenue up every year), barriers to entry (operating margin), strong
 *            balance sheet (debt vs free cash flow), attractive price (free-cash-flow yield)
 * US-listed shares use Nasdaq's reported year in dollars, others onvista's in euros.
 */
function investors(an, { ly, last, priceUsd, shares, stats, add, today }) {
  const us = an.us;
  const ov = an.annual.filter(r => !r.estimate && r.eps != null).at(-1);
  const usd = !!(ly && priceUsd && shares);
  const c = usd ? '$' : '€', price = usd ? priceUsd : last;
  const year = usd ? ly.period.slice(0, 4) : ov?.label;
  const eps = usd ? (ly.netIncome != null ? ly.netIncome / shares : null) : ov?.eps ?? null;
  const book = usd ? (ly.equity != null ? ly.equity / shares : null)
                   : ov?.marketCap && ov.pb && an.profile?.shares ? ov.marketCap / ov.pb / an.profile.shares : null;
  if (price == null || eps == null) return;
  const yrs = usd ? us.years : an.annual.filter(r => !r.estimate && r.netIncome != null);
  const losses = yrs.filter(y => y.netIncome < 0).map(y => (y.period ?? y.label).slice(0, 4));
  const steady = yrs.length >= 3 ? !losses.length : null;
  // dividend yield: US - the last 12 months of payouts (Nasdaq) over the price; else onvista's last year
  const yearAgo = new Date(Date.parse(today) - 365 * 864e5).toISOString().slice(0, 10);
  const dy = usd ? (us.dividends ?? []).filter(d => d.exDate > yearAgo).reduce((t, d) => t + d.amount, 0) / priceUsd * 100
                 : an.annual.filter(r => !r.estimate && r.divYield != null).at(-1)?.divYield ?? null;
  const pe = eps > 0 ? price / eps : null, pb = book > 0 ? price / book : null;

  // Graham
  const gn = eps > 0 && book > 0 ? Math.sqrt(22.5 * eps * book) : null;
  const gChecks = [
    [`P/E ≤ 15 (${pe != null ? n0(pe) : 'loss'})`, pe != null ? pe <= 15 : false],
    [`P/E × P/B ≤ 22,5 (${pe != null && pb != null ? n0(pe * pb) : '–'})`, pe != null && pb != null ? pe * pb <= 22.5 : null],
    [`current ratio ≥ 2 (${stats.currentRatio != null ? n1(stats.currentRatio) : '–'})`, stats.currentRatio != null ? stats.currentRatio >= 2 : null],
    [`profit every year shown${losses.length ? ` (loss ${losses.join(', ')})` : ''}`, steady],
    ['pays a dividend', dy == null ? null : dy > 0],
  ];
  Object.assign(stats, { grahamNumber: gn, epsLastYear: eps, bookPerShare: book });
  add('Graham', gn == null ? 'bad' : price <= gn ? 'good' : 'bad',
    gn != null
      ? `Graham number ${n2(gn)} ${c} = √(22,5 × EPS ${n2(eps)} ${c} × book value ${n2(book)} ${c} a share, ${year}): the most he would pay. The price ${n2(price)} ${c} is ${n0(Math.abs(growth(price, gn)))} % ${price > gn ? 'above' : 'below'} it.`
      : `No Graham number: ${eps <= 0 ? 'no profit' : 'no book value'} in ${year}.`,
    'green: price at or under the Graham number - the most Graham would pay (P/E 15 × P/B 1,5) · red: above it',
    gn != null ? `max ${n2(gn)} ${c} · price ${pct(growth(price, gn))}` : 'no Graham number',
    gChecks.map(([label, ok]) => ({ label, ok })));

  // Buffett
  const roe = usd ? stats.roe : ov?.roe ?? null, gm = usd ? stats.grossMargin : null;
  const debtYears = usd && stats.debt != null && ly.netIncome > 0 ? stats.debt / ly.netIncome : null;
  const fcfAll = usd && us.years.every(y => y.operatingCashFlow != null) ? us.years.every(y => y.operatingCashFlow + (y.capex ?? 0) > 0) : null;
  const bChecks = [
    [`return on equity ≥ 15 % (${roe != null ? n1(roe) : '–'})`, roe != null ? roe >= 15 : null],
    [`gross margin ≥ 40 % (${gm != null ? n0(gm) : '–'})`, gm != null ? gm >= 40 : null],
    [`debt ≤ 5 years of profit (${debtYears != null ? n1(debtYears) : ly?.netIncome <= 0 ? 'loss' : '–'})`, debtYears != null ? debtYears <= 5 : usd && ly.netIncome <= 0 ? false : null],
    [`profit every year shown${losses.length ? ` (loss ${losses.join(', ')})` : ''}`, steady],
    ['free cash flow every year shown', fcfAll],
  ];
  const known = bChecks.filter(([, ok]) => ok != null), passed = known.filter(([, ok]) => ok).length;
  Object.assign(stats, { buffettPassed: passed, buffettOf: known.length });
  if (known.length >= 2) {
    add('Buffett', passed >= known.length - 1 && passed >= 3 ? 'good' : passed <= known.length / 2 ? 'bad' : 'neutral',
      `${passed} of ${known.length} checks passed${known.length < bChecks.length ? `, ${bChecks.length - known.length} without data` : ''}. Buffett published no formula: these are the checks commonly drawn from his letters - returns, pricing power, little debt, steady profit and cash.`,
      `Buffett published no formula: checks commonly drawn from his letters. Green: all, or all but one (3 or more) · red: half or fewer. "?" = no data for it`,
      `${passed} of ${known.length} checks`, bChecks.map(([label, ok]) => ({ label, ok })));
  }

  // Lynch
  const est = usd ? (us.epsForecast ?? []).filter(f => f.year > year && f.eps > 0).map(f => ({ year: f.year, eps: f.eps }))
                  : an.annual.filter(r => r.estimate && r.eps > 0).map(r => ({ year: r.label.slice(0, 4), eps: r.eps }));
  const far = est.at(-1), n = far ? Number(far.year) - Number(year) : 0;
  if (pe != null && far && n > 0) {
    const g = ((far.eps / eps) ** (1 / n) - 1) * 100, y = dy ?? 0, ratio = (g + y) / pe;
    Object.assign(stats, { lynchGrowth: g, lynchRatio: ratio, lynchFairPrice: eps * (g + y) });
    add('Lynch', ratio >= 1.5 ? 'good' : ratio < 1 ? 'bad' : 'neutral',
      `(growth ${n0(g)} % + dividend ${n1(y)} %) ÷ P/E ${n0(pe)} = ${n2(ratio)}. Growth is a year, from EPS ${n2(eps)} ${c} (${year}) to analysts' ${n2(far.eps)} ${c} (${far.year}).`
      + ` At ${n2(eps * (g + y))} ${c} the P/E would equal growth + dividend.${g > 25 ? ' Lynch distrusted growth above 25 % a year: it rarely lasts.' : ''}`,
      'Lynch: under 1 is poor, 1,5 okay, 2 or more what he looked for. Green: 1,5 or more · red: under 1',
      `${n2(ratio)} · fair at ${n2(eps * (g + y))} ${c}`);
  }

  // Ackman
  const revs = usd ? us.years.map(y => y.revenue) : an.annual.filter(r => !r.estimate && r.revenue != null).map(r => r.revenue);
  const rising = revs.length >= 3 ? revs.every((v, i) => !i || v > revs[i - 1]) : null;
  const om = usd ? stats.operatingMargin : ov?.ebitMargin ?? null, fcf = usd ? stats.freeCashFlow : null;
  const debtFcf = usd && stats.debt != null && fcf != null ? (stats.debt <= 0 ? 0 : fcf > 0 ? stats.debt / fcf : Infinity) : null;
  const aChecks = [
    ['free cash flow every year shown', fcfAll],
    ['revenue up every year shown', rising],
    [`operating margin ≥ 15 % (${om != null ? n1(om) : '–'})`, om != null ? om >= 15 : null],
    [`debt ≤ 3 years of free cash flow (${debtFcf == null ? '–' : Number.isFinite(debtFcf) ? n1(debtFcf) : 'no free cash'})`, debtFcf != null ? debtFcf <= 3 : null],
    [`free cash flow yield ≥ 5 % (${stats.fcfYield != null ? n1(stats.fcfYield) : '–'})`, stats.fcfYield != null ? stats.fcfYield >= 5 : null],
  ];
  const aKnown = aChecks.filter(([, ok]) => ok != null), aPassed = aKnown.filter(([, ok]) => ok).length;
  Object.assign(stats, { ackmanPassed: aPassed, ackmanOf: aKnown.length });
  if (aKnown.length >= 2) {
    add('Ackman', aPassed >= aKnown.length - 1 && aPassed >= 3 ? 'good' : aPassed <= aKnown.length / 2 ? 'bad' : 'neutral',
      `${aPassed} of ${aKnown.length} checks passed${aKnown.length < aChecks.length ? `, ${aChecks.length - aKnown.length} without data` : ''}. Pershing Square's stated criteria: simple, predictable,`
      + ' free-cash-flow generative, barriers to entry, a strong balance sheet, an attractive price - plus two no number can test: little exposure to outside forces, and good management.',
      'Ackman published criteria, not a formula: these are the measurable ones. Green: all, or all but one (3 or more) · red: half or fewer. "?" = no data for it',
      `${aPassed} of ${aKnown.length} checks`, aChecks.map(([label, ok]) => ({ label, ok })));
  }
}

/** "5.000 € would make it 34 % of your stocks" - red from 25 % in one stock. null for no amount. */
export function depotPoint(fit, an, amount) {
  if (!fit || !(amount > 0)) return null;
  return { topic: 'In your depot', group: groupOf('In your depot'), tone: fit.weightAfter >= 25 ? 'bad' : 'neutral',
    head: `${n0(fit.weightAfter)} % of the depot`,
    text: `${n0(amount)} € would make it ${n0(fit.weightAfter)} % of your stocks + crypto (${n0(fit.totalAfter / 100)} €)`
      + `${fit.largestAfter.key !== an.key ? `; your largest stays ${fit.largestAfter.name} at ${n0(fit.largestAfter.weight)} %` : '; your largest position'}.`
      + `${fit.cash != null && amount * 100 > fit.cash ? ` More than your cash at Trade Republic (${n0(fit.cash / 100)} €).` : ''}`,
    rule: 'red: one stock at 25 % or more of the depot' };
}

/** The amount (euros) at which this stock reaches `pct` % of the depot: 0 if it is there already. */
export function amountFor(depot, an, pct) {
  const total = depot.positions.reduce((s, p) => s + p.value, 0);
  const mine = depot.positions.find(p => p.key === an.key)?.value ?? 0, w = pct / 100;
  return Math.max(0, (w * total - mine) / (1 - w) / 100);
}

/** Weights and the mix by position, sector and country before and after buying `amount` euros of this stock. */
export function fitIn(depot, an, amount) {
  const cents = Math.round((Number(amount) || 0) * 100);
  const pos = depot.positions.map(p => ({ key: p.key, name: p.name, value: p.value, country: p.country || 'Unknown', sector: p.sector || 'Unknown', usd: /^US/.test(p.key) }));
  let me = pos.find(p => p.key === an.key);
  const before = pos.map(p => ({ ...p }));
  if (!me) pos.push(me = { key: an.key, name: an.name, value: 0, country: an.profile?.country || 'Unknown', sector: an.profile?.sector || 'Unknown', usd: /^US/.test(an.key) });
  me.value += cents;
  const sum = list => list.reduce((s, p) => s + p.value, 0);
  const totalBefore = sum(before), totalAfter = sum(pos);
  const mix = (list, total, by) => {
    const m = new Map(); for (const p of list) m.set(by(p), (m.get(by(p)) || 0) + p.value);
    return Object.fromEntries([...m].map(([k, v]) => [k, total ? v / total * 100 : 0]));
  };
  // share before -> after, grouped by `by`; `mine` marks the group this stock is in
  const split = by => {
    const b = mix(before, totalBefore, by), a = mix(pos, totalAfter, by);
    return [...new Set([...Object.keys(b), ...Object.keys(a)])]
      .map(k => ({ name: k, before: b[k] ?? 0, after: a[k] ?? 0, mine: k === by(me) })).sort((x, y) => y.after - x.after);
  };
  const names = new Map(pos.map(p => [p.key, p.name]));
  const countries = split(p => p.country).map(({ name, ...r }) => ({ country: name, ...r }));
  const sectors = split(p => p.sector).map(({ name, ...r }) => ({ sector: name, ...r }));
  const positions = split(p => p.key).map(({ name, ...r }) => ({ key: name, name: names.get(name), ...r }));
  const top = pos.slice().sort((a, b) => b.value - a.value)[0];
  return {
    amount: cents, totalBefore, totalAfter, cash: depot.cash ?? null,
    weightBefore: totalBefore ? (before.find(p => p.key === an.key)?.value ?? 0) / totalBefore * 100 : 0,
    weightAfter: totalAfter ? me.value / totalAfter * 100 : 0,
    largestAfter: { key: top.key, name: top.name, weight: totalAfter ? top.value / totalAfter * 100 : 0 },
    countries, sectors, positions,
    usdBefore: totalBefore ? sum(before.filter(p => p.usd)) / totalBefore * 100 : 0,
    usdAfter: totalAfter ? sum(pos.filter(p => p.usd)) / totalAfter * 100 : 0,
  };
}
