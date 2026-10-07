/**
 * A read-out for one stock, made from the numbers - no model, no opinion. The same data
 * always gives the same text. Each point has a tone (good / bad / neutral) by a fixed rule,
 * written next to it, so the reader can see why it is green or red.
 *
 *   readout({ an, closes, quote, news, depot, amount, today, names, rates, own })
 *     an       analysis(key) - onvista + Nasdaq + FINRA
 *     closes   [[YYYY-MM-DD, close EUR], ...] ascending, a year or more
 *     quote    { last, prev } EUR now
 *     news     headlines for this stock, last 7 days, with .story
 *     depot    { positions: [{ key, name, value (cents), country }], cash (cents) } or null
 *     amount   euros you think of buying, 0 for none
 *     names    words a headline must contain to count for a theme ("Sea", "SE"), case-sensitive
 *     rates    ECB: { date, fx, bond10y } or null (lib/rates.mjs)
 *     own      the company's own profit measure: { label, perShare (EUR), period } or null (lib/kpis.mjs)
 *   -> { points: [{ topic, tone, text, rule }], fit, themes, stats }
 *
 *   epsView(an, today)              reported EPS, analysts' years ahead, the next 12 months, and whether they agree
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
const day = s => new Date(s.slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
// a fiscal year '24/25' ends somewhere in 2025: taken as 30 June
const yearEnd = l => (/^\d{4}$/.test(l) ? `${l}-12-31` : /^\d{2}\/\d{2}$/.test(l) ? `20${l.slice(3)}-06-30` : null);
const yearOf = l => Number(yearEnd(l)?.slice(0, 4)) || null;
const middle = list => { const v = list.filter(x => x > 0).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
const sym = c => (c === 'USD' ? '$' : c === 'EUR' ? '€' : c ?? '');
/**
 * Tax withheld abroad on dividends for a German private investor, by the company's country: [withheld %,
 * credited in Germany %] - the treaty rate counts against the 25 % Abgeltungsteuer, the rest is lost
 * unless reclaimed in that country. Standard rates; the US with the W-8BEN form brokers file.
 */
const WITHHOLDING = { USA: [15, 15], Canada: [25, 15], Switzerland: [35, 15], France: [25, 12.8], Netherlands: [15, 15],
  Denmark: [27, 15], Sweden: [30, 15], Norway: [25, 15], Finland: [35, 15], Spain: [19, 15], Italy: [26, 15], Austria: [27.5, 15],
  Belgium: [30, 15], Ireland: [25, 15], Portugal: [25, 15], Luxembourg: [15, 15], Japan: [15.315, 15], Australia: [30, 15],
  'United Kingdom': [0, 0], Germany: [0, 0] };
/** A split is a ratio of small whole numbers (3:2 = 1,5); anything else (1,2439) a spin-off or a capital measure. */
export const isSplit = f => [1, 2, 3, 4, 5, 10].some(b => Math.abs(f * b - Math.round(f * b)) < 0.002);

/**
 * Earnings per share from onvista (EUR): the last reported year, the analysts' years still ahead and the
 * next twelve months, blended from the two years they fall in. `otherBasis`: the first estimate is over
 * twice or under half the reported EPS - the analysts measure another profit (Brookfield: distributable
 * earnings, 2,49 € for 2026, against IFRS 0,44 € for 2025), so growth from one to the other means nothing.
 * onvista does not always flag estimates (Ipsen 2026-2028): a year counts as reported once it has ended.
 */
export function epsView(an, today) {
  const rows = an.annual.filter(r => yearEnd(r.label));
  const actual = rows.filter(r => !r.estimate && r.eps != null && yearEnd(r.label) <= today).at(-1) ?? null;
  const ahead = rows.filter(r => r.eps > 0 && yearEnd(r.label) > today).map(r => ({ label: r.label, eps: r.eps, end: yearEnd(r.label) }));
  const [a, b] = ahead;
  const left = a ? Math.min(1, Math.max(0, (Date.parse(a.end) - Date.parse(today)) / (365.25 * 864e5))) : 0;
  const ratio = actual?.eps > 0 && a ? a.eps / actual.eps : null;
  return { actual, ahead, ntm: a ? (b ? left * a.eps + (1 - left) * b.eps : a.eps) : null, ratio,
           otherBasis: ratio != null && (ratio > 2 || ratio < 0.5) };
}

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
  { id: 'business', label: 'Business', topics: ['Growth', 'Profit', 'Earnings', 'Outlook', 'Returns', 'Cash flow', 'Balance sheet', 'Company numbers', 'Data'] },
  { id: 'value', label: 'Valuation', topics: ['Valuation', 'Graham', 'Buffett', 'Lynch', 'Ackman'] },
  { id: 'market', label: "Who's buying", topics: ['Analysts', 'Insiders', 'Short interest', 'Funds', 'News'] },
  { id: 'facts', label: 'Good to know', topics: ['Next results', 'Dividend', 'Management', 'Listing', 'In your depot'] },
];
export const groupOf = topic => (GROUPS.find(g => g.topics.includes(topic)) ?? GROUPS.at(-1)).id;

/**
 * Each point: topic, tone, head (the one number to read at a glance), text (the full sentence),
 * rule (why the colour), checks ([{ label, ok }] for an investor's list), group.
 */
export function readout({ an, closes = [], quote, news = [], depot = null, amount = 0, today, names = [], rates = null, own = null }) {
  const points = [];
  const add = (topic, tone, text, rule, head = null, checks = null) =>
    points.push({ topic, group: groupOf(topic), tone, head, text, rule, ...(checks ? { checks } : {}) });
  const us = an.us, last = quote?.last ?? closes.at(-1)?.[1] ?? null;
  const stats = {}, pe = peHistory(an, closes, last), ev = epsView(an, today);
  const usIsin = !!an.isin?.startsWith('US'), kind = an.profile?.kind ?? null;   // 'bank' | 'insurer' | null
  const bond = rates?.bond10y ?? null;
  const toEur = (v, c) => (v == null ? null : c === 'EUR' ? v : rates?.fx?.[c] ? v / rates.fx[c] : null);
  const cf = an.cashflow, cfy = (cf?.years ?? []).filter(y => y.free != null);    // Yahoo, shares with a non-US ISIN
  // Nasdaq's last full year can lag onvista's (Micron: Nasdaq to Aug 2025, onvista has 25/26 with 8× the profit):
  // the newer one counts, so Nasdaq's years are then left out of growth, profit, returns, P/E and the investors
  const usLast = usIsin ? us?.years?.at(-1) : null;
  const usStale = !!(usLast && ev.actual && Date.parse(yearEnd(ev.actual.label)) - Date.parse(usLast.period) > 120 * 864e5);
  const usYears = usStale ? null : us?.years;

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
  const yrs = usYears?.length >= 2
    ? usYears.map(y => ({ label: y.period.slice(0, 4), revenue: y.revenue, netIncome: y.netIncome, c: 'USD' }))
    : an.annual.filter(r => !r.estimate && r.revenue != null).map(r => ({ label: r.label, revenue: r.revenue, netIncome: r.netIncome, c: 'EUR' }));
  if (yrs.length >= 2) {
    const [b, a] = yrs.slice(-2), first = yrs.at(-4) ?? yrs[0], span = yrs.length - 1 - yrs.indexOf(first);
    const g = growth(a.revenue, b.revenue), cagr = span >= 2 && first.revenue > 0 ? ((a.revenue / first.revenue) ** (1 / span) - 1) * 100 : null;
    Object.assign(stats, { revenueYear: a.label, revenue: a.revenue, revenueGrowth: g, revenueCagr: cagr, currency: a.c });
    add('Growth', g == null ? 'neutral' : g >= 15 ? 'good' : g < 0 ? 'bad' : 'neutral',
      `Revenue ${a.label}: ${big(a.revenue)} ${cur(a.c)} (${pct(g)} on ${b.label})${cagr != null ? `; ${pct(cagr)} a year over ${span} years` : ''}.`,
      'green: revenue +15 % or more · red: shrinking', `revenue ${pct(g)}`);

    if (a.netIncome != null) {
      const margin = a.revenue ? a.netIncome / a.revenue * 100 : null, before = b.revenue && b.netIncome != null ? b.netIncome / b.revenue * 100 : null;
      const lossYears = yrs.filter(y => y.netIncome < 0).map(y => y.label);
      const since = a.netIncome > 0 && lossYears.length ? yrs.find(y => y.label > lossYears.at(-1))?.label : null;
      stats.netIncome = a.netIncome; stats.margin = margin; stats.marginBefore = before;
      add('Profit', a.netIncome < 0 ? 'bad' : b.netIncome != null && a.netIncome > b.netIncome ? 'good' : 'neutral',
        a.netIncome < 0
          ? `Loss ${a.label}: ${big(a.netIncome)} ${cur(a.c)}${b.netIncome != null ? ` (${b.label}: ${big(b.netIncome)})` : ''}.`
          : `Net income ${a.label}: ${big(a.netIncome)} ${cur(a.c)}, ${n1(margin)} % of revenue${b.netIncome != null ? `, ${b.label}: ${big(b.netIncome)}` : ''}.`
            + `${before != null && b.netIncome > 0 ? ` The margin ${margin > before ? 'rose' : margin < before ? 'fell' : 'held'} from ${n1(before)} %.` : ''}`
            + `${since ? ` Profitable since ${since}, losses before.` : ''}`,
        'green: profit grew · red: a loss',
        a.netIncome < 0 ? `loss ${big(a.netIncome)} ${cur(a.c)}` : `${big(a.netIncome)} ${cur(a.c)} · ${n1(margin)} % margin`);
    }
    if (yrs.at(-1).c === 'EUR' && Number(yrs.at(-1).label.slice(0, 4)) < Number(today.slice(0, 4)) - 1) stats.stale = yrs.at(-1).label;
  }

  // earnings per share over up to five years (net income for US-listed shares: Nasdaq's reported years)
  const series = usIsin && usYears?.length >= 3
    ? usYears.map(y => ({ label: y.period.slice(0, 4), v: y.netIncome, what: 'Net income', unit: '$' }))
    : an.annual.filter(r => !r.estimate && r.eps != null && yearEnd(r.label) && yearEnd(r.label) <= today).map(r => ({ label: r.label, v: r.eps, what: 'EPS', unit: '€' }));
  if (series.length >= 3) {
    const a = series.at(-1), b = series.at(-2), show = v => (a.what === 'EPS' ? `${n2(v)} €` : `${big(v)} $`);
    // the longest stretch, up to 5 years, that starts with a profit of at least a tenth of the last one -
    // from almost nothing (Deutsche Bank 2020: 0,07 €) any growth rate is possible
    let start = null, span = 0;
    for (let k = Math.min(5, series.length - 1); k >= 2 && !start; k--) {
      const s0 = series.at(-1 - k);
      if (s0.v > 0 && s0.v >= a.v / 10) { start = s0; span = k; }
    }
    const g1 = a.v > 0 && b.v > 0 ? growth(a.v, b.v) : null;
    const gN = start && a.v > 0 ? ((a.v / start.v) ** (1 / span) - 1) * 100 : null;
    Object.assign(stats, { earningsGrowth1y: g1, earningsGrowthYearly: gN, earningsSpan: span });
    add('Earnings', a.v <= 0 || (gN != null && gN < 0) ? 'bad' : gN >= 10 && (g1 == null || g1 >= 0) ? 'good' : 'neutral',
      `${a.what} ${a.label}: ${show(a.v)}${g1 != null ? ` (${pct(g1)} on ${b.label})` : ` (${b.label}: ${show(b.v)})`}`
      + `${gN != null ? `; ${pct(gN)} a year over ${span} years, from ${show(start.v)} in ${start.label}` : ''}.`
      + `${g1 != null && gN != null ? ` Last year ${g1 > gN ? 'faster' : 'slower'} than that pace.` : ''}`
      + `${own ? ` The company steers by its own measure (${own.label}): see its company numbers.` : ''}`,
      `green: ${a.what} up 10 % a year or more over up to 5 years, and not down last year · red: down over that time, or a loss`,
      gN != null ? `${pct(gN)} a year · ${span} years` : `${a.what} ${show(a.v)}`);
  }

  // what analysts expect: EPS growth a year to their furthest estimate - from estimate to estimate when they
  // measure another profit than the one reported
  const outlook = (() => {
    if (usIsin && us?.epsForecast?.length && usYears?.length && us.price && us.market?.marketCap) {
      const ly0 = us.years.at(-1), sh = us.market.marketCap / us.price;
      const est = us.epsForecast.filter(f => f.year > ly0.period.slice(0, 4) && f.eps > 0).map(f => ({ label: f.year, eps: f.eps, analysts: f.analysts }));
      return { actual: ly0.netIncome != null ? { label: ly0.period.slice(0, 4), eps: ly0.netIncome / sh } : null, ahead: est, c: '$' };
    }
    return { actual: ev.actual, ahead: ev.ahead, c: '€' };
  })();
  if (outlook.ahead.length) {
    const [a] = outlook.ahead, far = outlook.ahead.at(-1), act = outlook.actual;
    const other = act?.eps > 0 && (a.eps / act.eps > 2 || a.eps / act.eps < 0.5);
    const from = other || !(act?.eps > 0) ? a : act, n = yearOf(far.label) - yearOf(from.label);
    const g = n > 0 ? ((far.eps / from.eps) ** (1 / n) - 1) * 100 : null, few = a.analysts != null && a.analysts < 3;
    Object.assign(stats, { expectedGrowth: g, estimatesOtherBasis: other });
    add('Outlook', g == null || few ? 'neutral' : g >= 15 ? 'good' : g < (bond ?? 0) ? 'bad' : 'neutral',
      `Analysts expect EPS of ${outlook.ahead.map(f => `${n2(f.eps)} ${outlook.c} (${f.label})`).join(', ')}`
      + `${g != null ? `: ${pct(g)} a year from ${from.label} to ${far.label}` : ''}.`
      + `${other ? ` Their estimates are ${n1(a.eps / act.eps)}× the reported ${n2(act.eps)} ${outlook.c} (${act.label}) - a big jump, or another measure of profit (adjusted, before one-offs) - so the growth runs from estimate to estimate.` : ''}`
      + `${bond != null ? ` 10-year euro bonds pay ${n1(bond)} % a year.` : ''}${few ? ` Only ${a.analysts} analyst${a.analysts === 1 ? '' : 's'}.` : ''}`,
      `green: analysts expect EPS to grow 15 % a year or more · red: less than 10-year euro bonds pay${bond != null ? ` (${n1(bond)} %)` : ''}. Fewer than 3 analysts: not judged`,
      g != null ? `${pct(g)} a year expected` : `${n2(a.eps)} ${outlook.c} ${a.label}`);
  }

  // returns, cash flow, balance sheet: Nasdaq's last reported year (USD), else onvista's ratios
  const mcapUsd = us?.market?.marketCap, priceUsd = us?.price;
  const ly = us?.years?.at(-1), py = us?.years?.at(-2), lyl = ly?.period.slice(0, 4);
  // the last year that has ended: onvista does not always flag estimates (On Holding, Ipsen list 2028 as if reported)
  const ov = an.annual.filter(r => !r.estimate && (!yearEnd(r.label) || yearEnd(r.label) <= today)).at(-1);
  const fy = an.reported?.at(-1), fy0 = an.reported?.[0];           // as filed, in the currency onvista lists them
  // an operating loss with a net profit: onvista's EBIT does not fit the company (Brookfield: −12,7 % in 2025)
  const ebitMargin = ov?.ebitMargin < 0 && ov?.netIncome > 0 ? null : ov?.ebitMargin ?? null;
  if (!usStale && ly?.equity && ly.netIncome != null) {
    const roe = ly.netIncome / ly.equity * 100, roa = ly.totalAssets ? ly.netIncome / ly.totalAssets * 100 : null;
    const gm = ly.grossProfit != null ? ly.grossProfit / ly.revenue * 100 : null, om = ly.operatingIncome != null ? ly.operatingIncome / ly.revenue * 100 : null;
    Object.assign(stats, { roe, roa, grossMargin: gm, operatingMargin: om });
    add('Returns', ly.equity < 0 || roe < 0 ? 'bad' : roe >= 15 ? 'good' : 'neutral',
      `${lyl}: ${n1(roe)} % return on equity${roa != null ? `, ${n1(roa)} % on assets` : ''}.`
      + `${gm != null && om != null ? ` Of 100 $ revenue, ${n0(gm)} $ gross profit and ${n1(om)} $ operating profit.` : ''}`,
      'green: return on equity 15 % or more · red: negative', `ROE ${n1(roe)} %`);
  } else if (fy?.equity > 0 && fy.netIncome != null) {
    const roe = fy.netIncome / fy.equity * 100, roa = fy.totalAssets ? fy.netIncome / fy.totalAssets * 100 : null;
    Object.assign(stats, { roe, roa });
    add('Returns', roe < 0 ? 'bad' : roe >= 15 ? 'good' : 'neutral',
      `${fy.label}: ${n1(roe)} % return on equity${roa != null ? `, ${n1(roa)} % on assets` : ''} - the shareholders' profit over their equity, as filed${fy.standard ? ` (${fy.standard})` : ''}.`
      + `${ebitMargin != null ? ` ${n1(ebitMargin)} % operating margin (onvista).` : ''}`,
      'green: return on equity 15 % or more · red: negative', `ROE ${n1(roe)} %`);
  } else if (ov?.roe != null) {
    stats.roe = ov.roe;
    add('Returns', ov.roe < 0 ? 'bad' : ov.roe >= 15 ? 'good' : 'neutral',
      `${ov.label}: ${n1(ov.roe)} % return on equity${ebitMargin != null ? `, ${n1(ebitMargin)} % operating margin` : ''} (onvista).`,
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
  } else if (cfy.length) {
    const a = cfy.at(-1), b = cfy.at(-2), c = sym(cf.currency), mcap = an.profile?.marketCap, fe = toEur(a.free, cf.currency);
    Object.assign(stats, { freeCashFlow: a.free, fcfYield: fe != null && mcap ? fe / mcap * 100 : null,
                           fcfEveryYear: cfy.length >= 3 ? cfy.every(y => y.free > 0) : null });
    add('Cash flow', kind ? 'neutral' : a.free < 0 ? 'bad' : b && a.free > b.free ? 'good' : 'neutral',
      `${a.year}: ${a.operating != null ? `${big(a.operating)} ${c} from operations, ${big(-(a.capex ?? 0))} ${c} invested - ` : ''}${big(a.free)} ${c} free cash flow`
      + `${b ? ` (${b.year}: ${big(b.free)})` : ''}${stats.fcfYield != null ? `, ${n1(stats.fcfYield)} % of the market value` : ''}.`
      + `${a.buybacks < 0 ? ` Bought back shares for ${big(-a.buybacks)} ${c}.` : ''}${a.dividendsPaid < 0 ? ` Paid ${big(-a.dividendsPaid)} ${c} in dividends.` : ''}`
      + `${a.free < 0 && a.operating > 0 ? ' Investing more than its operations bring in.' : ''} (Yahoo)`,
      'green: free cash flow positive and higher than the year before · red: negative', `free ${big(a.free)} ${c}`);
  } else if (ov?.cashflow != null) {
    add('Cash flow', ov.cashflow < 0 ? 'bad' : 'neutral',
      `${ov.label}: ${big(ov.cashflow)} € cash flow${ov.pcf != null ? `, the price is ${n0(ov.pcf)}× that` : ''} (onvista).`, 'red: negative', `${big(ov.cashflow)} €`);
  }

  // banks and insurers run on borrowed money: cash vs debt, current ratio and interest cover do not judge them
  const notFor = kind ? ` A ${kind === 'bank' ? 'bank' : 'insurer'} runs on borrowed money: these ratios do not judge it.` : '';
  if (ly?.equity != null && ly.totalAssets) {
    const cash = (ly.cash ?? 0) + (ly.shortInvestments ?? 0), debt = (ly.shortDebt ?? 0) + (ly.longDebt ?? 0), net = cash - debt;
    const cr = ly.currentAssets && ly.currentLiabilities ? ly.currentAssets / ly.currentLiabilities : null;
    const cover = ly.interestExpense > 0 && ly.ebit != null ? ly.ebit / ly.interestExpense : null;
    const ocfDebt = debt > 0 && ly.operatingCashFlow != null ? ly.operatingCashFlow / debt * 100 : null;
    Object.assign(stats, { cash, debt, netCash: net, currentRatio: kind ? null : cr, debtToEquity: ly.equity > 0 ? debt / ly.equity : null,
                           interestCover: cover, cashFlowToDebt: ocfDebt });
    add('Balance sheet', kind ? 'neutral' : ly.equity <= 0 || (cr != null && cr < 1) || (cover != null && cover < 1.5) ? 'bad' : net >= 0 ? 'good' : 'neutral',
      `End of ${lyl}: ${big(cash)} $ cash and short-term investments, ${big(debt)} $ debt${ly.shortDebt ? ` (${big(ly.shortDebt)} due within a year)` : ''}`
      + ` - ${net >= 0 ? `net cash ${big(net)} $` : `net debt ${big(-net)} $`}.`
      + `${cr != null ? ` Current assets cover ${n1(cr)}× what is due within a year.` : ''}`
      + `${stats.debtToEquity != null ? ` Debt is ${n2(stats.debtToEquity)}× equity.` : ''}`
      + `${cover != null ? ` Operating profit covers the interest ${n1(cover)}×.` : ''}`
      + `${ocfDebt != null && net < 0 ? ` A year of operating cash flow pays ${n0(ocfDebt)} % of the debt.` : ''}${notFor}`,
      'green: more cash than debt · red: less in current assets than is due within a year, interest covered less than 1,5×, or no equity left',
      net >= 0 ? `net cash ${big(net)} $` : `net debt ${big(-net)} $`);
  } else if (fy?.totalAssets && fy.liabilities != null) {
    const c = fy.currency ?? '', eq = (fy.equity ?? 0) + (fy.minorities ?? 0), eq0 = (fy0.equity ?? 0) + (fy0.minorities ?? 0);
    const le = eq > 0 ? fy.liabilities / eq : null, le0 = fy0 !== fy && eq0 > 0 ? fy0.liabilities / eq0 : null;
    const cr = fy.currentAssets && fy.currentLiabilities ? fy.currentAssets / fy.currentLiabilities : null;
    const cover = fy.interestPaid > 0 && fy.pretax != null ? (fy.pretax + fy.interestPaid) / fy.interestPaid : null;
    Object.assign(stats, { currentRatio: kind ? null : cr, liabilitiesToEquity: le, interestCover: cover });
    add('Balance sheet', kind ? 'neutral'
      : eq <= 0 || (cr != null && cr < 1) || (cover != null && cover < 1.5) ? 'bad'
      : cover != null && cover >= 5 && le != null && le <= 2 && !(le0 != null && le > le0 * 1.2) ? 'good' : 'neutral',
      `End of ${fy.label}, as filed${fy.standard ? ` (${fy.standard})` : ''}: ${fy.cash != null ? `${big(fy.cash)} ${c} cash, ` : ''}`
      + `${le != null ? `liabilities ${n1(le)}× equity${le0 != null ? ` (${fy0.label}: ${n1(le0)}×)` : ''}` : 'no equity left'}.`
      + `${cr != null ? ` Current assets cover ${n1(cr)}× what is due within a year.` : ''}`
      + `${cover != null ? ` Profit before interest and tax covers the interest paid ${n1(cover)}×.` : ''}`
      + `${fy.minorities > (fy.equity ?? 0) ? ' Most of the equity belongs to minority partners: the figures include companies it controls but only partly owns.' : ''}${notFor}`,
      'green: interest covered 5× or more, liabilities at most 2× equity and not up 20 % over the years shown · red: interest covered less than 1,5×, or less in current assets than is due within a year',
      le != null ? `liabilities ${n1(le)}× equity` : 'no equity');
  } else if (ov?.equityRatio != null) {
    add('Balance sheet', 'neutral', `${ov.label}: equity is ${n0(ov.equityRatio)} % of the balance sheet (onvista).`, '', `equity ${n0(ov.equityRatio)} %`);
  }

  // valuation: what one year of profit and of sales costs
  if (mcapUsd || an.profile?.marketCap) {
    const parts = [];
    const lastY = usIsin && !usStale ? us?.years?.at(-1) : null;
    // on estimates first - the P/E Trade Republic and most sites show: Nasdaq's in dollars for US ISINs,
    // onvista's in euros for the rest, plus the next 12 months
    const fwd = usIsin && !usStale ? (us?.epsForecast || []).filter(f => f.eps > 0).slice(0, 2) : [];
    if (priceUsd && fwd.length) {
      stats.forwardPe = fwd.map(f => ({ year: f.year, pe: priceUsd / f.eps, analysts: f.analysts }));
      parts.push(`price/earnings ${stats.forwardPe.map(f => `${n0(f.pe)} on ${f.year} estimates`).join(', ')} (${fwd[0].analysts ?? '?'} analysts)`);
    } else if ((!usIsin || usStale) && last != null && ev.ahead.length) {   // onvista's EPS of an ADR can count another share
      stats.forwardPe = ev.ahead.slice(0, 2).map(f => ({ year: f.label, pe: last / f.eps }));
      stats.ntmPe = ev.ntm ? last / ev.ntm : null;
      parts.push(`price/earnings ${stats.forwardPe.map(f => `${n0(f.pe)} on ${f.year} estimates`).join(', ')}${stats.ntmPe != null ? `, ${n0(stats.ntmPe)} on the next 12 months` : ''}`);
    }
    // ... and on the last profit reported
    const lead = parts.length ? '' : 'price/earnings ';
    if (lastY) { if (mcapUsd && lastY.netIncome > 0) { stats.pe = mcapUsd / lastY.netIncome; stats.peYear = lastY.period.slice(0, 4); } }
    else if (usIsin && pe?.now != null) { stats.pe = pe.now; stats.peYear = pe.basis; }
    else if (last != null && ev.actual?.eps > 0) { stats.pe = last / ev.actual.eps; stats.peYear = ev.actual.label; }
    else { const per = an.annual.filter(r => !r.estimate && r.per).at(-1); if (per) { stats.pe = per.per; stats.peYear = `${per.label}, onvista`; } }
    if (stats.pe != null) parts.push(`${lead}${n0(stats.pe)} on the ${stats.peYear} profit reported`);
    if (own?.perShare > 0 && last != null) {
      stats.ownPe = last / own.perShare;
      parts.push(`${n0(stats.ownPe)} on its own measure (${own.label}, ${own.period}: ${n2(own.perShare)} € a share)`);
    }
    if (mcapUsd && lastY?.revenue) { stats.ps = mcapUsd / lastY.revenue; parts.push(`price/sales ${n1(stats.ps)}`); }
    if (mcapUsd && lastY?.equity > 0) { stats.pb = mcapUsd / lastY.equity; parts.push(`price/book ${n1(stats.pb)}`); }
    else if (!lastY && ov?.pb) {
      // price/book and price/cash flow against the stock's own past (onvista, the reported years)
      const past = an.annual.filter(r => !r.estimate && yearEnd(r.label) && yearEnd(r.label) <= today);
      const mid = k => (past.filter(r => r[k] > 0).length >= 5 ? middle(past.map(r => r[k])) : null);
      stats.pb = ov.pb; stats.pbMedian = mid('pb'); stats.pcfMedian = mid('pcf');
      parts.push(`price/book ${n1(ov.pb)} in ${ov.label}${stats.pbMedian ? ` (middle of ${past.length} years: ${n1(stats.pbMedian)})` : ''}`);
      if (ov.pcf > 0) parts.push(`price/cash flow ${n1(ov.pcf)}${stats.pcfMedian ? ` (middle: ${n1(stats.pcfMedian)})` : ''}`);
    }
    // PEG: P/E divided by the expected yearly earnings growth - near 1 means the price matches the growth.
    // onvista's mixes the reported EPS with estimates of another profit: left out then
    const peg = usIsin ? us?.peg?.value ?? null : ev.otherBasis ? null : an.annual.find(r => r.estimate && r.peg != null)?.peg ?? null;
    if (peg > 0) { stats.peg = peg; parts.push(`PEG ${n2(peg)}`); }
    const eg = usIsin ? us?.peg?.growth ?? [] : [];
    const mc = mcapUsd ? `${big(mcapUsd)} $` : `${big(an.profile.marketCap)} ${cur(an.profile.marketCapCurrency)}`;
    // earnings yield: what a year of (estimated) profit pays on the price, against a safe 10-year bond
    const fpe = stats.ntmPe ?? stats.forwardPe?.[0]?.pe ?? null;
    if (fpe > 0) stats.earningsYield = 100 / fpe;
    if (pe) stats.peMedian = pe.median;
    add('Valuation', lastY?.netIncome < 0 ? 'bad' : 'neutral',
      `Market value ${mc}${parts.length ? `; ${parts.join('; ')}` : ''}.`
      + `${eg.length ? ` Analysts expect earnings per share ${eg.map(g => `${pct(g.pct)} in ${g.year}`).join(', ')}.` : ''}`
      + `${!usIsin && ev.otherBasis ? ` The estimates (${n2(ev.ahead[0].eps)} € for ${ev.ahead[0].label}) are ${n1(ev.ratio)}× the reported ${n2(ev.actual.eps)} € (${ev.actual.label}) - a big jump, or another measure of profit (adjusted, before one-offs) - so compare P/E on estimates only with P/E on estimates.` : ''}`
      + `${stats.earningsYield != null && bond != null ? ` On the estimates it earns ${n1(stats.earningsYield)} % of its price a year; 10-year euro bonds pay ${n1(bond)} %.` : ''}`
      + `${pe ? ` Against its own past: P/E ${pe.now != null ? n0(pe.now) : 'over 100'} now, ${n0(pe.median)} in the middle since ${day(pe.since)} (yearly profit${pe.nasdaq.length ? `, ${pe.nasdaq.join(', ')} from Nasdaq` : ''}).` : ''}`,
      'red: no profit to measure against · otherwise not judged - compare with peers. PEG = P/E ÷ expected earnings growth: near 1, the price matches the growth',
      stats.forwardPe?.length ? `P/E ${n0(stats.forwardPe[0].pe)} on ${stats.forwardPe[0].year} est.${stats.pe != null ? ` · ${n0(stats.pe)} on ${stats.peYear}` : ''}`
        : stats.pe != null ? `P/E ${n0(stats.pe)} on ${stats.peYear}` : `worth ${mc}`);
  }

  // three investors' tests, by their published rules; per share, in the listing's currency
  const shares = (mcapUsd && priceUsd ? mcapUsd / priceUsd : null) || an.profile?.shares || null;
  // book value a share, as filed (shareholders' equity in euros at the ECB rate) - onvista's P/B lacks years
  const bookEur = fy?.equity > 0 && an.profile?.shares ? toEur(fy.equity, fy.currency) / an.profile.shares : null;
  investors(an, { ly: usIsin && !usStale ? ly : null, last, priceUsd, shares, stats, add, today, ev, ebitMargin, kind, bookEur });

  // analysts (US-listed only)
  const at = us?.analysts;
  if (at) {
    const n = at.buy + at.hold + at.sell;
    add('Analysts', at.upside >= 15 && at.buy > n / 2 ? 'good' : at.upside < 0 || at.sell > at.buy ? 'bad' : 'neutral',
      `${at.buy} buy, ${at.hold} hold, ${at.sell} sell. Average target ${n2(at.target)} $ (${pct(at.upside)} vs ${n2(at.price)} $), range ${n0(at.low)}–${n0(at.high)} $.`,
      'green: most say buy and the target is 15 % or more above · red: target below the price or more sells than buys',
      `${at.buy} of ${n} buy · target ${pct(at.upside)}`);
  }

  // who buys and sells: insiders (Nasdaq's Form 4 for US ISINs, BaFin's directors' dealings for German
  // issuers), short sellers, funds (shares listed in the US)
  const ins = us?.insiders ?? an.insiders;
  if (ins) {
    const { buys, sells, sold, bought } = ins.m3, planned = ins.recent.filter(t => /automatic/i.test(t.type)).length;
    Object.assign(stats, { insiderSells3m: sells, insiderBuys3m: buys, insiderNetShares3m: bought - sold });
    add('Insiders', buys > sells ? 'good' : sells > 0 && !buys ? 'bad' : 'neutral',
      (buys + sells
        ? `Last 3 months: ${sells} sales, ${buys} buys${sold ? `; ${big(sold)} shares sold${shares ? ` (${n2(sold / shares * 100)} % of all shares${ins.source && last ? `, ≈ ${big(sold * last)} € at today's price` : priceUsd ? `, ≈ ${big(sold * priceUsd)} $ at today's price` : ''})` : ''}` : ''}.`
        : 'No insider trades in the last 3 months.')
      + ` 12 months: ${ins.m12.sells} sales, ${ins.m12.buys} buys${ins.m12.sold || ins.m12.bought ? ` (net ${big(ins.m12.bought - ins.m12.sold)} shares)` : ''}.`
      + `${ins.recent.length && !ins.source ? ` ${planned} of the latest ${ins.recent.length} under a pre-set trading plan.` : ''}`
      + `${ins.recent[0]?.name ? ` Latest: ${ins.recent[0].name}${ins.recent[0].relation ? ` (${ins.recent[0].relation})` : ''}, ${String(ins.recent[0].type ?? '').toLowerCase()}`
        + `${ins.recent[0].shares ? ` ${big(ins.recent[0].shares)} shares` : ''}${ins.recent[0].date ? ` on ${day(ins.recent[0].date)}` : ''}.` : ''}`
      + `${ins.source ? ` (${ins.source} directors' dealings)` : ''}`,
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

  // dividend: covered by profit, steady over the years shown (split-adjusted; a spin-off is not a cut), what comes next
  const paid = an.annual.filter(r => !r.estimate && r.dps != null && yearEnd(r.label) && yearEnd(r.label) <= today);
  const dps = paid.at(-1);
  // besides the dividend: buybacks over the market value, and the share count a year (adjusted for later splits)
  const mcapE = an.profile?.marketCap ?? null, lb = cfy.at(-1)?.buybacks;
  const bb = usIsin ? (ly?.stock < 0 && mcapUsd ? -ly.stock / mcapUsd * 100 : null)
                    : lb < 0 && mcapE ? toEur(-lb, cf.currency) / mcapE * 100 : null;
  // Yahoo's count is as reported - adjusted for a later split at some companies (Novo), not at others
  // (Brookfield): a split between two years counts only where the count jumps by about its factor
  const sh = (cf?.years ?? []).filter(y => y.shares > 0).map(y => ({ year: y.year, end: y.end, n: y.shares }));
  for (let i = sh.length - 1; i > 0; i--) {
    const f = (an.splits ?? []).filter(s => isSplit(s.factor) && s.date > sh[i - 1].end && s.date <= sh[i].end).reduce((x, s) => x * s.factor, 1);
    const jump = sh[i].n / sh[i - 1].n;
    if (f > 1.1 && jump > f * 0.85 && jump < f * 1.15) for (let j = 0; j < i; j++) sh[j].n *= f;
  }
  const shareChange = sh.length >= 3 ? ((sh.at(-1).n / sh[0].n) ** (1 / (sh.length - 1)) - 1) * 100 : null;
  Object.assign(stats, { buybackYield: bb, sharesChangeYearly: shareChange });
  const back = `${bb != null ? ` Buybacks: ${n1(bb)} % of the market value${dps?.dps && last ? `, ${n1(dps.dps / last * 100 + bb)} % returned with the dividend` : ''}.` : ''}`
    + `${shareChange != null ? ` Share count ${shareChange > 0 ? '+' : '−'}${n1(Math.abs(shareChange))} % a year over ${sh.length - 1} years${shareChange < 0 ? ': each share owns a little more' : ''}.` : ''}`;
  if (an.type === 'STOCK' && !dps?.dps) add('Dividend', 'neutral', `No dividend: the company keeps its profit.${back}`, '', bb ? `none · buybacks ${n1(bb)} %` : 'none');
  else if (an.type === 'STOCK') {
    const hist = paid.slice(-11).map(r => ({ label: r.label, v: r.dpsAdj ?? r.dps }));
    const spun = new Set((an.splits ?? []).filter(s => !isSplit(s.factor))
      .flatMap(s => [Number(s.date.slice(0, 4)), Number(s.date.slice(0, 4)) + 1]));
    const cuts = hist.filter((r, i) => i && hist[i - 1].v > 0 && r.v < hist[i - 1].v * 0.9 && !spun.has(yearOf(r.label))).map(r => r.label);
    const excused = hist.some((r, i) => i && hist[i - 1].v > 0 && r.v < hist[i - 1].v * 0.9 && spun.has(yearOf(r.label)));
    const first = hist.find(r => r.v > 0), n = hist.length - 1;
    const payout = dps.eps > 0 ? dps.dps / dps.eps * 100 : null;
    const next = an.annual.find(r => r.dps > 0 && yearEnd(r.label) > today), y = last ? dps.dps / last * 100 : dps.divYield ?? 0;
    const ex = [...an.annual].reverse().find(r => r.exDividend)?.exDividend ?? null;
    const dChecks = [
      [`pays out at most 90 % of its profit (${payout != null ? n0(payout) : '–'})`, payout != null ? payout <= 90 : null],
      [`no cut over 10 % in ${n} years${cuts.length ? ` (${cuts.join(', ')})` : ''}${excused ? ', a spin-off year excepted' : ''}`, n >= 4 ? !cuts.length : null],
      [`higher than ${n} years ago${first ? ` (${n2(first.v)} € in ${first.label})` : ''}`, n >= 4 && first ? hist.at(-1).v > first.v : null],
      [`share count up at most 2 % a year (${shareChange != null ? `${shareChange > 0 ? '+' : '−'}${n1(Math.abs(shareChange))}` : '–'})`, shareChange != null ? shareChange <= 2 : null],
    ];
    const known = dChecks.filter(([, ok]) => ok != null);
    // after tax past the 1.000 € allowance: withheld abroad + the German 25 % (+ Soli) less what is credited
    const [w, c] = WITHHOLDING[an.profile?.country] ?? [null, null];
    const net = w != null ? y * (1 - w / 100 - Math.max(0, 25 - c) / 100 * 1.055) : null;
    Object.assign(stats, { payout, dividendCuts: cuts, forwardYield: next && last ? next.dps / last * 100 : null, withheld: w, yieldAfterTax: net });
    add('Dividend', (payout != null && payout > 100) || cuts.some(l => yearOf(l) >= yearOf(dps.label) - 2) ? 'bad'
      : known.length >= 2 && known.every(([, ok]) => ok) ? 'good' : 'neutral',
      `${n2(dps.dps)} € a share (${dps.label}), ${n1(y)} % at today's price${payout != null ? `, ${n0(payout)} % of the profit` : ''}.`
      + `${next && last ? ` Analysts expect ${n2(next.dps)} € for ${next.label} (${n1(next.dps / last * 100)} % at today's price).` : ''}`
      + `${ex ? ` ${ex >= today ? 'Next' : 'Last'} ex-dividend date ${day(ex)}.` : ''}${back}`
      + `${w ? ` ${an.profile.country} withholds ${n1(w)} %${w > c ? `; Germany credits ${n1(c)} %, the other ${n1(w - c)} % comes back only if you reclaim it there` : ', all of it credited in Germany'}.` : ''}`
      + `${net != null ? ` After tax past your 1.000 € allowance about ${n1(net)} % instead of ${n1(y)} %.` : ''}`,
      'green: profit covers it (90 % or less paid out), no cut over 10 %, higher than at the start of the years shown, and no more than 2 % new shares a year · red: more than the profit paid out, or a cut in the last 3 years. A spin-off is not a cut',
      `${n1(y)} % yield${payout != null ? ` · ${n0(payout)} % of profit` : ''}`, dChecks.map(([label, ok]) => ({ label, ok })));
  }

  const ceo = an.profile?.ceo;
  if (ceo?.name) add('Management', 'neutral',
    `CEO ${ceo.name}${ceo.payRatio ? `, paid ${n0(ceo.payRatio)}× the company's median employee` : ''} (onvista, from its sustainability reporting).`, '', `CEO ${ceo.name}`);

  // where it trades, and in which currency
  if (usIsin && an.profile?.country && an.profile.country !== 'USA') {
    add('Listing', 'neutral', `A US-listed share (ADR) of a company from ${an.profile.country}. It trades in dollars: in euros your result also moves with EUR/USD.`, '', 'ADR in US dollars');
  } else if (usIsin) {
    add('Listing', 'neutral', 'Trades in dollars: in euros your result also moves with EUR/USD.', '', 'in US dollars');
  } else if (us?.listedAs) {
    add('Listing', 'neutral', `Also trades in New York as ${us.listedAs}${us.market?.exchange ? ` (${us.market.exchange})` : ''}, in dollars: analysts, funds and short interest here come from that listing.`
      + `${fy?.currency && fy.currency !== 'EUR' ? ` Its figures are in ${fy.currency}: in euros your result also moves with the exchange rate.` : ''}`, '', `also ${us.listedAs} in the US`);
  }

  // what the read-out stands on, and how fresh it is
  const asOf = [
    quote?.venue ? `price ${quote.venue}${quote.at ? ` ${day(quote.at)}` : ''}` : null,
    fy?.end ? `last year filed to ${day(fy.end)}${fy.standard ? ` (${fy.standard})` : ''}` : ov ? `financials to ${ov.label}` : null,
    ev.ahead.length ? `estimates to ${ev.ahead.at(-1).label}` : null,
    us ? `Nasdaq${us.listedAs ? ` (US listing ${us.listedAs})` : ''}` : null,
    own ? `company numbers to ${own.period.split('–').at(-1)}` : null,
    rates?.date ? `ECB rates ${day(rates.date)}` : null,
  ].filter(Boolean);
  if (asOf.length) add('Data', 'neutral',
    `${stats.stale ? `The financials end in ${stats.stale} (onvista) - newer years are missing here. ` : ''}Based on: ${asOf.join(' · ')}.`, '',
    stats.stale ? `financials end ${stats.stale}` : fy?.label ? `filed to ${fy.label}` : 'sources');
  const dp0 = points.find(p => p.topic === 'Data');
  if (usStale && dp0) dp0.text += ` Nasdaq's last full year ends ${day(usLast.period)}, onvista already has ${ev.actual.label}: the newer one is used.`;

  const fit = depot ? fitIn(depot, an, amount) : null;
  const dp = fit && depotPoint(fit, an, amount);
  if (dp) points.push(dp);
  return { points, groups: GROUPS, fit, themes: th, stats, pe };
}

/**
 * Price/earnings by day: how expensive the stock is against its own past. The price that day ÷
 * earnings per share, blended in a straight line between two year ends (about the last twelve
 * months); after the last reported year they stay at that year. No P/E in or just after a loss
 * year, nor above 100. Earnings per share, by listing:
 *   at home   onvista's EPS. Its market value can be off: Novartis and Roche counted twice,
 *             Merck KGaA and Novo Nordisk only the listed shares.
 *   US-listed net income ÷ today's share count (Nasdaq's): onvista's EPS for an ADR counts another
 *             share (1 PDD ADS = 4 shares) and switches unit within one history (Alibaba).
 *             Years onvista lacks (Sea: it stops at 2023) from Nasdaq, in euros at today's rate.
 *   -> { dates, values, median, now, since, basis, nasdaq } or null; at most ~520 points
 */
export function peHistory(an, closes, last) {
  if (closes.length < 20 || !last) return null;
  const end = yearEnd;
  // onvista does not always flag estimates (Ipsen 2026-2028): a year counts once it has ended
  const actual = an.annual.filter(r => !r.estimate && end(r.label) && end(r.label) <= closes.at(-1)[0]);
  let yrs;
  if (an.isin?.startsWith('US')) {
    const mcapUsd = an.us?.market?.marketCap, priceUsd = an.us?.price;
    const shares = mcapUsd && priceUsd ? mcapUsd / priceUsd : an.profile?.marketCap ? an.profile.marketCap / last : null;
    if (!shares) return null;
    yrs = actual.filter(r => r.netIncome != null).map(r => ({ label: r.label, eps: r.netIncome / shares, end: end(r.label) }));
    if (priceUsd) for (const y of an.us?.years ?? []) {
      if (y.netIncome != null && y.period.slice(0, 4) > (yrs.at(-1)?.end ?? '').slice(0, 4))
        yrs.push({ label: y.period.slice(0, 4), eps: y.netIncome * last / priceUsd / shares, end: y.period, nasdaq: true });
    }
  } else {
    yrs = actual.filter(r => r.eps != null && r.eps !== 0).map(r => ({ label: r.label, eps: r.eps, end: end(r.label) }));   // 0: a gap (Ipsen 2024)
  }
  if (!yrs.length) return null;
  const epsAt = d => {
    const i = yrs.findLastIndex(y => y.end <= d);
    if (i < 0) return null;
    const a = yrs[i], b = yrs[i + 1];
    if (!b || a.eps <= 0) return a.eps;                          // no blend out of a loss: break-even is no P/E
    const f = (Date.parse(d) - Date.parse(a.end)) / (Date.parse(b.end) - Date.parse(a.end));
    return a.eps + (b.eps - a.eps) * f;
  };
  const peAt = (d, p) => { const e = epsAt(d), pe = e > 0 ? p / e : null; return pe != null && pe <= 100 ? pe : null; };
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
function investors(an, { ly, last, priceUsd, shares, stats, add, today, ev, ebitMargin, kind, bookEur }) {
  const us = an.us;
  const ov = ev.actual ?? an.annual.filter(r => !r.estimate && r.eps != null).at(-1);
  const usd = !!(ly && priceUsd && shares);
  const c = usd ? '$' : '€', price = usd ? priceUsd : last;
  const year = usd ? ly.period.slice(0, 4) : ov?.label;
  const eps = usd ? (ly.netIncome != null ? ly.netIncome / shares : null) : ov?.eps ?? null;
  const book = usd ? (ly.equity != null ? ly.equity / shares : null)
                   : bookEur ?? (ov?.marketCap && ov.pb && an.profile?.shares ? ov.marketCap / ov.pb / an.profile.shares : null);
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
  add('Graham', gn == null ? (eps <= 0 ? 'bad' : 'neutral') : price <= gn ? 'good' : 'bad',
    gn != null
      ? `Graham number ${n2(gn)} ${c} = √(22,5 × EPS ${n2(eps)} ${c} × book value ${n2(book)} ${c} a share, ${year}): the most he would pay. The price ${n2(price)} ${c} is ${n0(Math.abs(growth(price, gn)))} % ${price > gn ? 'above' : 'below'} it.`
      : `No Graham number: ${eps <= 0 ? 'no profit' : 'no book value'} in ${year}.`,
    'green: price at or under the Graham number - the most Graham would pay (P/E 15 × P/B 1,5) · red: above it, or no profit',
    gn != null ? `max ${n2(gn)} ${c} · price ${pct(growth(price, gn))}` : 'no Graham number',
    gChecks.map(([label, ok]) => ({ label, ok })));

  // Buffett
  // banks and insurers: gross margin, debt and free cash flow do not apply - left without data
  const roe = stats.roe ?? ov?.roe ?? null, gm = usd && !kind ? stats.grossMargin : null;
  const debtYears = usd && !kind && stats.debt != null && ly.netIncome > 0 ? stats.debt / ly.netIncome : null;
  const fcfAll = kind ? null : usd ? (us.years.every(y => y.operatingCashFlow != null) ? us.years.every(y => y.operatingCashFlow + (y.capex ?? 0) > 0) : null)
                             : stats.fcfEveryYear ?? null;                      // Yahoo's years for non-US ISINs
  const bChecks = [
    [`return on equity ≥ 15 % (${roe != null ? n1(roe) : '–'})`, roe != null ? roe >= 15 : null],
    [`gross margin ≥ 40 % (${gm != null ? n0(gm) : '–'})`, gm != null ? gm >= 40 : null],
    [`debt ≤ 5 years of profit (${debtYears != null ? n1(debtYears) : ly?.netIncome <= 0 ? 'loss' : '–'})`, debtYears != null ? debtYears <= 5 : usd && !kind && ly.netIncome <= 0 ? false : null],
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

  // Lynch. When the estimates measure another profit than the reported EPS (over 2× or under half of
  // it), growth and P/E both run on estimates: from the first to the furthest, P/E on the first
  const est = usd ? (us.epsForecast ?? []).filter(f => f.year > year && f.eps > 0).map(f => ({ year: f.year, eps: f.eps }))
                  : ev.ahead.map(f => ({ year: f.label, eps: f.eps }));
  const other = eps > 0 && est[0] && (est[0].eps / eps > 2 || est[0].eps / eps < 0.5);
  const base = other ? est[0] : { year, eps }, far = est.at(-1), n = far ? yearOf(far.year) - yearOf(base.year) : 0;
  const peL = other ? price / base.eps : pe;
  if (peL != null && far && n > 0) {
    const g = ((far.eps / base.eps) ** (1 / n) - 1) * 100, y = dy ?? 0, ratio = (g + y) / peL;
    Object.assign(stats, { lynchGrowth: g, lynchRatio: ratio, lynchFairPrice: base.eps * (g + y) });
    add('Lynch', ratio >= 1.5 ? 'good' : ratio < 1 ? 'bad' : 'neutral',
      `(growth ${n0(g)} % + dividend ${n1(y)} %) ÷ P/E ${n0(peL)}${other ? ` on ${base.year}` : ''} = ${n2(ratio)}. Growth is a year, from ${other ? 'analysts\' ' : 'EPS '}${n2(base.eps)} ${c} (${base.year}) to analysts' ${n2(far.eps)} ${c} (${far.year}).`
      + `${other ? ` The estimates are far from the reported ${n2(eps)} ${c} (${year}) - a big jump, or another measure of profit - so both ends are estimates.` : ''}`
      + ` At ${n2(base.eps * (g + y))} ${c} the P/E would equal growth + dividend.${g > 25 ? ' Lynch distrusted growth above 25 % a year: it rarely lasts.' : ''}`,
      'Lynch: under 1 is poor, 1,5 okay, 2 or more what he looked for. Green: 1,5 or more · red: under 1',
      `${n2(ratio)} · fair at ${n2(base.eps * (g + y))} ${c}`);
  }

  // Ackman
  const revs = usd ? us.years.map(y => y.revenue) : an.annual.filter(r => !r.estimate && r.revenue != null).map(r => r.revenue);
  const rising = revs.length >= 3 ? revs.every((v, i) => !i || v > revs[i - 1]) : null;
  const om = kind ? null : usd ? stats.operatingMargin : ebitMargin, fcf = usd && !kind ? stats.freeCashFlow : null;
  const debtFcf = usd && stats.debt != null && fcf != null ? (stats.debt <= 0 ? 0 : fcf > 0 ? stats.debt / fcf : Infinity) : null;
  const aChecks = [
    ['free cash flow every year shown', fcfAll],
    ['revenue up every year shown', rising],
    [`operating margin ≥ 15 % (${om != null ? n1(om) : '–'})`, om != null ? om >= 15 : null],
    [`debt ≤ 3 years of free cash flow (${debtFcf == null ? '–' : Number.isFinite(debtFcf) ? n1(debtFcf) : 'no free cash'})`, debtFcf != null ? debtFcf <= 3 : null],
    [`free cash flow yield ≥ 5 % (${stats.fcfYield != null && !kind ? n1(stats.fcfYield) : '–'})`, stats.fcfYield != null && !kind ? stats.fcfYield >= 5 : null],
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
