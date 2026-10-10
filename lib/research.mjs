/**
 * A read-out for one stock, made from the numbers - no model, no opinion. The same data
 * always gives the same text. Each point has a tone (good / bad / neutral) by a fixed rule,
 * written next to it, so the reader can see why it is green or red.
 *
 *   readout({ an, closes, quote, news, depot, amount, today, names, rates, own, file })
 *     an       analysis(key) - onvista + Nasdaq + FINRA; a fund's own data in an.fund
 *     closes   [[YYYY-MM-DD, close EUR], ...] ascending, a year or more
 *     quote    { last, prev } EUR now
 *     news     headlines for this stock, last 7 days, with .story
 *     depot    { positions: [{ key, name, value (cents), country }], cash (cents) } or null
 *     amount   euros you think of buying, 0 for none
 *     names    words a headline must contain to count for a theme ("Sea", "SE"), case-sensitive
 *     rates    ECB: { date, fx, bond10y } or null (lib/rates.mjs)
 *     own      the company's own profit measure: { label, perShare (EUR), period } or null (lib/kpis.mjs)
 *     file     its company file, briefed (lib/dossier.mjs brief): insiders, politicians, analysts, contracts, holders,
 *              CEO, next results - each used where no feed has it, or beside the feed's
 *   -> { points: [{ topic, tone, text, rule }], fit, themes, stats }
 *
 *   epsView(an, today)              reported EPS, analysts' years ahead, the next 12 months, and whether they agree
 *   results(estimates)              the last quarters' EPS (and revenue) against the analysts' estimate: beats, misses
 *   peHistory(an, closes, last)     price/earnings by day, against the stock's own past
 *   peAhead(pe, forward)            that line on into the analysts' years, if the price stays
 *   upDown(closes, last, stats, analysts, today)  up to the analysts' target, down to the 200-day average
 *   score(points, groups)           share of judged points that speak for it, 0-100, by group and for all
 *   fitIn(depot, an, amount)        weights, position / sector / country mix before / after buying `amount` euros
 *                                   (a fund by what it holds: an.fund countries, sectors, currencies)
 *   depotPoint(fit, an, amount)     the read-out's "In your depot" point for that, or null
 *   (no imports: the page loads this file too, so the slider recomputes without asking the server)
 *
 *   themes(news, names)   what the headlines are about: insider sales, up/downgrades, beats/misses, legal
 *   naming(names, others) title -> does it name the company? (whole word, case-sensitive - a name in small letters
 *                         in any case; not where it is part of
 *                         another company's name: others)
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
const pct1 = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${n1(Math.abs(v))} %`;
const w0 = v => (v < 1 ? n1(v) : n0(v));
// where analysts' numbers come from: "Yahoo, 2 analysts"
const by = (source, n) => `${source ?? 'onvista'}${n ? `, ${n} analyst${n === 1 ? '' : 's'}` : ''}`;
// "ASML (ADR)" and "ASML Holding" are one company: the name without brackets and legal forms
const bareName = n => String(n ?? '').replace(/\([^)]*\)/g, ' ')
  .replace(/[,.]?\s*\b(Inc|Corp|Corporation|Ltd|Limited|plc|AG|SE|N\.?V|S\.?A|Holdings?|Group|Co)\b\.?/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
// onvista writes index names in capitals: "MSCI EUROPE SELECT ... INDEX" -> "MSCI Europe Select ... Index"
const indexName = n => (n && n === n.toUpperCase() ? n.replace(/\p{L}{5,}/gu, w => w[0] + w.slice(1).toLowerCase()) : n);
const HOW = { full: 'holding all of its shares', sampling: 'holding a sample of its shares',
              swap: 'by a swap: it holds other shares and a bank pays it the index\'s return' };
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
 * Earnings per share in euros: the last reported year, the analysts' years still ahead and the next twelve
 * months, blended from the two years they fall in. Analysts' years are Yahoo's where it has them (with how many
 * analysts), else onvista's - analysis.mjs merges them into an.annual and flags a year an estimate until it is
 * filed. A year ended but not yet filed still counts ahead, for four months. `otherBasis`: the first estimate is
 * over twice or under half the reported EPS - the analysts measure another profit (Brookfield: distributable
 * earnings, 2,49 € for 2026, against IFRS 0,44 € for 2025), so growth from one to the other means nothing.
 */
export function epsView(an, today) {
  const rows = an.annual.filter(r => yearEnd(r.label));
  const actual = rows.filter(r => !r.estimate && r.eps != null && yearEnd(r.label) <= today).at(-1) ?? null;
  const open = r => (r.end ?? yearEnd(r.label)) > today || (r.estimate && Date.parse(today) - Date.parse(r.end ?? yearEnd(r.label)) <= 122 * 864e5);
  const ahead = rows.filter(r => r.eps > 0 && open(r))
    .map(r => ({ label: r.label, eps: r.eps, end: r.end ?? yearEnd(r.label), analysts: r.epsAnalysts ?? null, source: r.source ?? 'onvista' }));
  const [a, b] = ahead;
  const left = a ? Math.min(1, Math.max(0, (Date.parse(a.end) - Date.parse(today)) / (365.25 * 864e5))) : 0;
  const ratio = actual?.eps > 0 && a ? a.eps / actual.eps : null;
  return { actual, ahead, ntm: a ? (b ? left * a.eps + (1 - left) * b.eps : a.eps) : null, ratio,
           otherBasis: ratio != null && (ratio > 2 || ratio < 0.5) };
}

/**
 * The last quarters against the analysts' estimate (an.estimates, Yahoo): EPS - Yahoo keeps the estimate - and
 * revenue where its estimate was saved before the results (data/estimates, app.mjs). Surprise in % of the estimate.
 *   -> { list: [{ end, date, eps, epsEstimate, epsSurprise, revenue, revenueEstimate, revenueSurprise }],
 *        beats, misses, judged } - the last four quarters with an EPS estimate
 */
export function results(E) {
  const off = (a, e) => (a != null && e ? (a - e) / Math.abs(e) * 100 : null);
  const list = (E?.reported ?? []).map(q => ({ ...q, epsSurprise: off(q.eps, q.epsEstimate), revenueSurprise: off(q.revenue, q.revenueEstimate) }));
  const last4 = list.filter(q => q.epsSurprise != null).slice(-4);
  return { list, beats: last4.filter(q => q.eps > q.epsEstimate).length, misses: last4.filter(q => q.eps < q.epsEstimate).length, judged: last4.length };
}
// a quarter by the month it ends: "Sep 2026" - fiscal quarters (Micron's end in August) need no naming
const quarter = e => new Date(`${e}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });

// ------------------------------------------------------------ headlines -> themes
// a beat or a miss is one against the numbers: "lose high-scoring game to Brookfield Academy, beat St. John's" is not
const RESULT = '(estimates?|expectations|forecasts?|consensus|views?|guidance|earnings|revenue|sales|profit|EPS|Q[1-4])\\b';
const THEMES = [
  { id: 'insider', label: 'insider sales', tone: 'bad', re: /\binsiders?\b.*\b(sells?|sold|sale|sales)\b|\b(sells?|sold)\b.*\bshares\b.*\binsider|\bunder a trading plan\b/i },
  { id: 'downgrade', label: 'downgrades', tone: 'bad', re: /\bdowngrad/i },
  { id: 'miss', label: 'missed estimates', tone: 'bad', re: new RegExp(`\\bmiss(es|ed)?\\b.*\\b${RESULT}|\\b${RESULT} miss\\b|\\bbelow (estimates|expectations)\\b|\\bfalls? short\\b`, 'i') },
  { id: 'legal', label: 'legal / regulators', tone: 'bad', re: /\blawsuit|\bclass action|\bprobe\b|\binvestigation\b|\bregulator|\bfined?\b|\bsued\b|\bantitrust/i },
  { id: 'upgrade', label: 'upgrades', tone: 'good', re: /\bupgrad/i },
  { id: 'beat', label: 'beat estimates', tone: 'good', re: new RegExp(`\\bbeats?\\b.*\\b${RESULT}|\\b${RESULT} beat\\b|\\btops? (estimates|expectations)\\b|\\babove (estimates|expectations)\\b`, 'i') },
  { id: 'buyback', label: 'buybacks', tone: 'good', re: /\bbuy-?backs?\b|\brepurchase/i },
  { id: 'target', label: 'price targets', tone: 'neutral', re: /\bprice target/i },
];

/**
 * One count per story, not per outlet: a story that 20 sites ran is still one insider sale.
 * Only headlines that name the company count - a keyword search also returns articles that
 * merely mention it ("Holland America ... upgrades").
 */
export function naming(names = [], others = []) {
  const esc = w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // a whole word also for names with letters \b does not know: "Ørsted"
  // and with a hyphen for a space: "Owens-Corning" is Owens Corning
  const word = (ws, flags) => new RegExp(`(?<![\\p{L}\\p{N}])(${ws.map(w => w.split(' ').map(esc).join('[\\s-]+')).join('|')})(?![\\p{L}\\p{N}])`, flags);
  // a name in small letters counts in any case: onvista's "SOFI" is "SoFi" in headlines (headlineNames)
  const ok = names.filter(Boolean), not = others.filter(Boolean).sort((a, b) => b.length - a.length);
  const exact = ok.filter(n => n !== n.toLowerCase()), any = ok.filter(n => n === n.toLowerCase());
  const re = exact.length ? word(exact, 'u') : null, reAny = any.length ? word(any, 'iu') : null;
  const other = not.length ? word(not, 'giu') : null;
  // "Brookfield Renewable Partners (NYSE:BEP) ..." is about Brookfield Renewable: its name taken out, nothing is left
  return title => {
    if (!re && !reAny) return true;
    const t = other ? title.replace(other, ' ') : title;
    return !!(re?.test(t) || reAny?.test(t));
  };
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
/** The read-out in six groups (Fund only for funds and ETFs), in this order; a topic not listed goes to the last. */
export const GROUPS = [
  { id: 'price', label: 'Price', topics: ['Price', 'Trend', 'Up / down', 'Swings'] },
  { id: 'fund', label: 'Fund', topics: ['Costs', 'Size', 'Index', 'Tracking', 'Track record', 'Holding', 'Holdings', 'Countries', 'Sectors'] },
  { id: 'business', label: 'Business', topics: ['Growth', 'Profit', 'Earnings', 'Outlook', 'Results', 'Returns', 'Cash flow', 'Balance sheet', 'Company numbers', 'Contracts', 'Data'] },
  { id: 'value', label: 'Valuation', topics: ['Stage', 'Scenarios', 'Valuation','Graham', 'Buffett', 'Lynch', 'Ackman'] },
  { id: 'market', label: "Who's buying", topics: ['Analysts', 'Insiders', 'Politicians', 'Short interest', 'Funds', 'Holders', 'News'] },
  { id: 'facts', label: 'Good to know', topics: ['Next results', 'Dividend', 'Payouts', 'Tax', 'Management', 'Listing', 'In your depot'] },
];
export const groupOf = topic => (GROUPS.find(g => g.topics.includes(topic)) ?? GROUPS.at(-1)).id;

/**
 * Each point: topic, tone, head (the one number to read at a glance), text (the full sentence),
 * rule (why the colour), checks ([{ label, ok }] for an investor's list), group.
 */
export function readout({ an, closes = [], quote, news = [], depot = null, amount = 0, today, names = [], rates = null, own = null, file = null }) {
  const points = [];
  const add = (topic, tone, text, rule, head = null, checks = null) =>
    points.push({ topic, group: groupOf(topic), tone, head, text, rule, ...(checks ? { checks } : {}) });
  const us = an.us, last = quote?.last ?? closes.at(-1)?.[1] ?? null;
  const stats = {}, pe = peHistory(an, closes, last), ev = epsView(an, today);
  const usIsin = !!an.isin?.startsWith('US'), kind = an.profile?.kind ?? null;   // 'bank' | 'insurer' | null
  // Nasdaq's figures count for US ISINs and for a company that files like a US one (analysis.mjs: usFiler)
  const usFigures = usIsin || !!us?.usFiler;
  const bond = rates?.bond10y ?? null;
  const toEur = (v, c) => (v == null ? null : c === 'EUR' ? v : rates?.fx?.[c] ? v / rates.fx[c] : null);
  const cf = an.cashflow, cfy = (cf?.years ?? []).filter(y => y.free != null);    // Yahoo, shares with a non-US ISIN
  // Nasdaq's last full year can lag onvista's (Micron: Nasdaq to Aug 2025, onvista has 25/26 with 8× the profit):
  // the newer one counts, so Nasdaq's years are then left out of growth, profit, returns, cash flow, balance sheet,
  // P/E and the investors - a free cash flow a year old against today's price is no yield (Micron: 0,1 %)
  const usLast = usFigures ? us?.years?.at(-1) : null;
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

  // analysts' targets: Nasdaq's for US-listed shares, else Yahoo's. A euro target counts as it is, against
  // today's price; in another currency (pence in London) only target ÷ their price counts
  const yt0 = !us?.analysts && an.targets?.target > 0 && an.targets.price > 0 ? an.targets : null;
  const yt = yt0 && last != null && yt0.currency === 'EUR' ? { ...yt0, price: last } : yt0;
  // else the ratings saved in its company file: each firm's latest of 12 months, targets in euros
  const fa = !us?.analysts && !yt && file?.analysts?.target > 0 && last != null ? file.analysts : null;
  const aim = us?.analysts ? { ...us.analysts, n: us.analysts.buy + us.analysts.hold + us.analysts.sell }
            : yt ? { target: yt.target, low: yt.low, high: yt.high, price: yt.price, n: yt.analysts }
            : fa ? { target: fa.target, low: fa.low, high: fa.high, price: last, n: fa.targets } : null;

  // up and down from here: to the analysts' average target, and to where the trend would break
  const ud = upDown(closes, last, stats, aim, today);
  if (ud) {
    const few = ud.analysts != null && ud.analysts < 3, an1 = `${ud.analysts} analyst${ud.analysts === 1 ? '' : 's'}`;
    Object.assign(stats, { upside: ud.up, downside: ud.down, downsideTo: ud.downTo, upPerDown: ud.ratio });
    add('Up / down', ud.ratio == null || few ? 'neutral' : ud.ratio >= 2 ? 'good' : ud.ratio < 1 ? 'bad' : 'neutral',
      `${ud.up != null ? `Up ${pct(ud.up)} to the analysts' average target (${n2(ud.target)} €${ud.analysts != null ? `, ${an1}` : ''}, their range ${n2(ud.low)}–${n2(ud.high)} €)`
                       : 'No analysts\' target found'}`
      + `${ud.down != null ? `; down ${pct(ud.down)} to the ${ud.downTo} (${n2(ud.level)} €)` : '; the price is at its 52-week low'}.`
      + `${ud.ratio != null ? ` ${n1(ud.ratio)} € up for each 1 € down.` : ''}${few ? ' Fewer than 3 analysts: not judged.' : ''}`,
      'green: 2 € or more up for each 1 € down · red: less up than down · fewer than 3 analysts: not judged. Up: the analysts\' '
      + 'average target - Nasdaq\'s for US-listed shares, else Yahoo\'s, else the ratings in its company file - in euros at today\'s price. Down: the 200-day average - '
      + 'where the trend would break - or the 52-week low when the price is already under it',
      ud.ratio != null ? `${pct(ud.up)} / ${pct(ud.down)} · ${n1(ud.ratio)} : 1` : ud.down != null ? `${pct(ud.down)} to the ${ud.downTo}` : `target ${pct(ud.up)}`);
  }

  // swings: beta against onvista's benchmark index
  const rk = an.risk;
  if (rk?.beta != null) {
    Object.assign(stats, { beta: rk.beta, volatility: rk.volatility });
    add('Swings', 'neutral',
      `Beta ${n2(rk.beta)} against the ${rk.benchmark ?? 'index'} over 250 days: when the index moved 1 %, it moved ${n2(rk.beta)} % on average.`
      + `${rk.volatility != null ? ` Volatility ${n0(rk.volatility)} % a year.` : ''}`, '', `beta ${n2(rk.beta)}`);
  }

  // a fund or ETF: what it costs, what it holds, how close it stays to its index, what it pays out
  const F = an.fund, hold = F ? holds(closes, F.payouts, toEur) : null;
  if (F) {
    const rk1 = F.risk?.y1, dd = ['y1', 'y3', 'y5'].filter(k => F.risk?.[k]?.maxDrawdown != null);
    if (rk1?.volatility != null) add('Swings', 'neutral',
      `Volatility ${n0(rk1.volatility)} % a year${dd.length ? `; its worst fall from a high: ${dd.map(k => `${pct(F.risk[k].maxDrawdown)} in ${k === 'y1' ? '1 year' : `${k.slice(1)} years`}`).join(', ')}` : ''}.`
      + `${F.riskClass ? ` Risk class ${F.riskClass} of 7 (the fund's key information document).` : ''}`, '', `volatility ${n0(rk1.volatility)} %`);
    if (F.ter != null) add('Costs', F.ter <= 0.2 ? 'good' : F.ter > 0.5 ? 'bad' : 'neutral',
      `${n2(F.ter)} % a year (ongoing charges), taken from the fund's value: about ${n0(F.ter * 10)} € a year on 1.000 €.`,
      'green: 0,20 % a year or less · red: over 0,50 %', `${n2(F.ter)} % a year`);
    if (F.size != null) add('Size', F.size < 100e6 ? 'bad' : F.size >= 1e9 ? 'good' : 'neutral',
      `${big(F.size)} € in the fund${F.sizeDate ? ` (${day(F.sizeDate)})` : ''}${F.launched ? `, launched ${day(F.launched)}` : ''}.`
      + `${F.size < 100e6 ? ' Small funds are closed or merged more often; a closure sells your shares, and the gain is taxed then.' : ''}`,
      'green: 1 bn € or more · red: under 100 m € - small funds are closed or merged more often', `${big(F.size)} €`);
    if (F.index || F.replication) add('Index', 'neutral',
      `Tracks the ${indexName(F.index) ?? 'index'}${HOW[F.replication] ? `, ${HOW[F.replication]}` : ''}.`
      + ` ${F.use === 'distributing' ? 'Pays out what its shares pay' : F.use === 'accumulating' ? 'Reinvests what its shares pay' : ''}`
      + `${F.issuer ? `${F.use ? '; ' : ''}issuer ${F.issuer}` : ''}${F.domicile ? `, fund based in ${F.domicile}` : ''}${F.currency ? `, in ${F.currency}` : ''}.`
      + `${F.morningstar ? ` Morningstar ${F.morningstar} of 5 stars.` : ''}`, '',
      [F.replication, F.use].filter(Boolean).join(' · ') || 'index');
    // the fund's return less the index's: what costs and holding only part of it took. 3 years judge it
    const vs = F.vsIndex ?? {}, span = vs['3Y'] != null ? 3 : vs['1Y'] != null ? 1 : null;
    if (span) {
      const yr = vs[`${span}Y`] / span;
      add('Tracking', yr >= -0.5 ? 'good' : yr < -1 ? 'bad' : 'neutral',
        `Its return less its index's (onvista): ${['1Y', '3Y', '5Y'].filter(k => vs[k] != null).map(k => `${k === '1Y' ? '1 year' : `${k[0]} years`} ${pct1(vs[k])}`).join(', ')}.`
        + ' Its fee is part of that gap.',
        'green: on 3 years at most 0,5 % a year behind its index · red: more than 1 % a year behind', `${pct1(yr)} a year vs index`);
    }
    const rt = F.returns;
    if (rt?.y1 != null) {
      const pa = (v, y) => (v != null ? ((1 + v / 100) ** (1 / y) - 1) * 100 : null);
      add('Track record', 'neutral',
        `Payouts included (onvista): 1 year ${pct(rt.y1)}${rt.y3 != null ? `, 3 years ${pct(rt.y3)} (${pct(pa(rt.y3, 3))} a year)` : ''}`
        + `${rt.y5 != null ? `, 5 years ${pct(rt.y5)} (${pct(pa(rt.y5, 5))} a year)` : ''}${rt.since != null && F.launched ? `, since ${F.launched.slice(0, 4)} ${pct(rt.since)}` : ''}.`
        + `${rt.years?.length ? ` By year: ${rt.years.map(y => `${y.year} ${pct(y.pct)}`).join(', ')}.` : ''}`, '',
        rt.y5 != null ? `5 years ${pct(rt.y5)}` : rt.y3 != null ? `3 years ${pct(rt.y3)}` : `1 year ${pct(rt.y1)}`);
    }
    // bought on any day and held: how often it ended with a gain, and the range of what 1.000 € became
    if (hold?.spans.length) {
      const S = hold.spans, e = x => `${n0(x * 1000)} €`;
      add('Holding', 'neutral',
        `Bought on any day since ${day(hold.from)} and held, payouts reinvested: `
        + S.map(s => `${s.years} year${s.years > 1 ? 's' : ''} - a gain on ${n0(Math.floor(s.up))} % of ${n0(s.n)} days, 1.000 € became ${e(s.worst)} to ${e(s.best)} (middle ${e(s.mid)})`).join('; ')
        + `.${hold.missed ? ` ${hold.missed} payout${hold.missed > 1 ? 's' : ''} in a currency without a rate left out.` : ''} Past prices, not a forecast.`,
        '', `${S[0].years} year: a gain ${n0(Math.floor(S[0].up))} % of days`);
    }
    const H = F.holdings ?? [];
    if (H.length) {
      const sum = H.reduce((t, h) => t + h.pct, 0);
      const have = depot ? H.filter(h => depot.positions.some(p => p.key === h.isin || bareName(p.name) === bareName(h.name))) : [];
      add('Holdings', H[0].pct >= 10 || sum >= 50 ? 'bad' : 'neutral',
        `Largest ${H.length}: ${H.map(h => `${h.name} ${n1(h.pct)} %`).join(', ')} - together ${n0(sum)} % of the fund${F.asOf ? ` (${day(F.asOf)})` : ''}.`
        + `${have.length ? ` You already hold ${have.map(h => h.name).join(', ')} yourself.` : ''}`,
        'red: one company 10 % or more of the fund, or its 10 largest half of it or more', `${H[0].name} ${n1(H[0].pct)} %`);
    }
    if (F.countries?.length) {
      const other = (F.currencies ?? []).filter(c => c.name !== 'EUR'), off = other.reduce((t, c) => t + c.pct, 0);
      add('Countries', 'neutral', `${F.countries.map(c => `${c.name} ${w0(c.pct)} %`).join(', ')}.`
        + `${F.currencies?.length ? ` Currencies: ${F.currencies.map(c => `${c.name} ${w0(c.pct)} %`).join(', ')}${off >= 1 ? ` - ${n0(off)} % not in euros: in euros your result also moves with those` : ''}.` : ''}`,
        '', F.countries.slice(0, 2).map(c => `${c.name} ${n0(c.pct)} %`).join(' · '));
    }
    if (F.sectors?.length) add('Sectors', 'neutral', `${F.sectors.map(c => `${c.name} ${w0(c.pct)} %`).join(', ')}.`, '',
      F.sectors.slice(0, 2).map(c => `${c.name} ${n0(c.pct)} %`).join(' · '));
    const P = F.payouts ?? [], since = d => new Date(Date.parse(today) - d * 864e5).toISOString().slice(0, 10);
    const y1 = P.filter(x => x.date > since(365)), y0 = P.filter(x => x.date > since(730) && x.date <= since(365));
    const sum1 = y1.reduce((t, x) => t + x.amount, 0), sum0 = y0.reduce((t, x) => t + x.amount, 0);
    if (F.use === 'distributing' && y1.length) {
      const yld = last ? sum1 / last * 100 : null;
      Object.assign(stats, { payoutYield: yld });
      add('Payouts', 'neutral',
        `${n2(sum1)} € a share in the last 12 months (${y1.length} payouts, last ${n2(P.at(-1).amount)} € on ${day(P.at(-1).date)})`
        + `${yld != null ? `, ${n1(yld)} % at today's price` : ''}${y0.length ? `; the 12 months before ${n2(sum0)} € (${pct(growth(sum1, sum0))})` : ''}.`,
        '', yld != null ? `${n1(yld)} % yield` : `${n2(sum1)} € a year`);
    } else if (F.use === 'accumulating') add('Payouts', 'neutral', 'None: the fund reinvests what its shares pay (accumulating).', '', 'none, reinvested');
    if (F.equity) add('Tax', 'neutral',
      'onvista lists it as an equity fund: in Germany 30 % of its payouts and of your gain on selling are tax-free (Teilfreistellung).'
      + `${F.use === 'accumulating' ? ' It pays nothing out, so each January a small tax on part of the last year\'s rise is due (Vorabpauschale).' : ''}`
      + ' Tax withheld abroad on its shares\' dividends stays in the fund: you cannot credit it.', '', '30 % tax-free');
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
  const series = usFigures && usYears?.length >= 3
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
    if (usFigures && us?.epsForecast?.length && usYears?.length && us.price && us.market?.marketCap) {
      const ly0 = us.years.at(-1), sh = us.market.marketCap / us.price;
      const est = us.epsForecast.filter(f => f.year > ly0.period.slice(0, 4) && f.eps > 0).map(f => ({ label: f.year, eps: f.eps, analysts: f.analysts, source: f.source }));
      return { actual: ly0.netIncome != null ? { label: ly0.period.slice(0, 4), eps: ly0.netIncome / sh } : null, ahead: est, c: '$' };
    }
    return { actual: ev.actual, ahead: ev.ahead, c: '€' };
  })();
  // revenue ahead: Yahoo's, in the company's own currency, each year on the one before
  const E = an.estimates, revs = (E?.years ?? []).filter(y => y.revenue != null);
  const revText = revs.length ? ` Revenue expected: ${revs.map(y => `${big(y.revenue)} ${sym(E.currency)} (${y.label}${y.revenueGrowth != null ? `, ${pct(y.revenueGrowth)}` : ''})`).join(', ')}`
    + ` - ${by('Yahoo', revs[0].revenueAnalysts)}.` : '';
  if (revs[0]?.revenueGrowth != null) stats.expectedRevenueGrowth = revs[0].revenueGrowth;
  if (outlook.ahead.length) {
    const [a] = outlook.ahead, far = outlook.ahead.at(-1), act = outlook.actual;
    const other = act?.eps > 0 && (a.eps / act.eps > 2 || a.eps / act.eps < 0.5);
    const from = other || !(act?.eps > 0) ? a : act, n = yearOf(far.label) - yearOf(from.label);
    const g = n > 0 ? ((far.eps / from.eps) ** (1 / n) - 1) * 100 : null, few = a.analysts != null && a.analysts < 3;
    Object.assign(stats, { expectedGrowth: g, estimatesOtherBasis: other, estimatesFrom: a.source ?? 'onvista', estimatesAnalysts: a.analysts ?? null });
    add('Outlook', g == null || few ? 'neutral' : g >= 15 ? 'good' : g < (bond ?? 0) ? 'bad' : 'neutral',
      `Analysts expect EPS of ${outlook.ahead.map(f => `${n2(f.eps)} ${outlook.c} (${f.label})`).join(', ')} - ${by(a.source, a.analysts)}`
      + `${g != null ? `: ${pct(g)} a year from ${from.label} to ${far.label}` : ''}.`
      + `${other ? ` Their estimates are ${n1(a.eps / act.eps)}× the reported ${n2(act.eps)} ${outlook.c} (${act.label}) - a big jump, or another measure of profit (adjusted, before one-offs) - so the growth runs from estimate to estimate.` : ''}`
      + `${revText}${bond != null ? ` 10-year euro bonds pay ${n1(bond)} % a year.` : ''}${few ? ` Fewer than 3 analysts: not judged.` : ''}`,
      `green: analysts expect EPS to grow 15 % a year or more · red: less than 10-year euro bonds pay${bond != null ? ` (${n1(bond)} %)` : ''}. Fewer than 3 analysts: not judged`,
      g != null ? `${pct(g)} a year expected` : `${n2(a.eps)} ${outlook.c} ${a.label}`);
  } else if (revs.length) {
    add('Outlook', 'neutral', `No analysts' EPS ahead.${revText}`, 'not judged: only EPS growth is',
      `revenue ${revs[0].revenueGrowth != null ? pct(revs[0].revenueGrowth) : big(revs[0].revenue)} ${revs[0].label}`);
  }

  // returns, cash flow, balance sheet: Nasdaq's last reported year (USD), else onvista's ratios
  const mcapUsd = us?.market?.marketCap, priceUsd = us?.price;
  const ly = usYears?.at(-1), py = usYears?.at(-2), lyl = ly?.period.slice(0, 4);
  // the last year reported (analysis.mjs flags one an estimate until it is filed)
  const ov = an.annual.filter(r => !r.estimate && (!yearEnd(r.label) || yearEnd(r.label) <= today)).at(-1);
  const fy = an.reported?.at(-1), fy0 = an.reported?.[0];           // as filed, in the currency onvista lists them
  // more than one share class (VW's ordinary and preferred, Swatch's bearer and registered): onvista's share count and
  // company value mix the classes (Swatch: 90 bn € for an 9 bn € company), its equity a share (€) counts every share -
  // equity over that gives them all, priced at this line for the market value
  const eqShare = an.annual.find(r => !r.estimate && r.label === fy?.label)?.bookPerShare ?? null;
  const allShares = eqShare > 0 && fy?.equity > 0 ? toEur(fy.equity, fy.currency) / eqShare : null;
  if (allShares && an.profile?.shares && last && Math.abs(allShares / an.profile.shares - 1) > 0.25)
    an = { ...an, profile: { ...an.profile, shares: allShares, marketCap: last * allShares, marketCapCurrency: 'EUR' } };
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
    const lastY = usFigures && !usStale ? us?.years?.at(-1) : null;
    // on estimates first - the P/E Trade Republic and most sites show: Nasdaq's in dollars for US ISINs,
    // onvista's in euros for the rest, plus the next 12 months
    // (Yahoo's first, analysis.mjs) - plus the next 12 months
    const fwd = usFigures && !usStale ? (us?.epsForecast || []).filter(f => f.eps > 0).slice(0, 2) : [];
    if (priceUsd && fwd.length) {
      stats.forwardPe = fwd.map(f => ({ year: f.year, pe: priceUsd / f.eps, analysts: f.analysts }));
      parts.push(`price/earnings ${stats.forwardPe.map(f => `${n0(f.pe)} on ${f.year} estimates`).join(', ')} (${by(fwd[0].source, fwd[0].analysts)})`);
    } else if ((!usFigures || usStale) && last != null && ev.ahead.length) {   // onvista's EPS of an ADR can count another share
      stats.forwardPe = ev.ahead.slice(0, 2).map(f => ({ year: f.label, pe: last / f.eps, analysts: f.analysts }));
      stats.ntmPe = ev.ntm ? last / ev.ntm : null;
      parts.push(`price/earnings ${stats.forwardPe.map(f => `${n0(f.pe)} on ${f.year} estimates`).join(', ')}${stats.ntmPe != null ? `, ${n0(stats.ntmPe)} on the next 12 months` : ''}`
        + ` (${by(ev.ahead[0].source, ev.ahead[0].analysts)})`);
    }
    // the P/E line on into those years, dashed on the chart
    if (pe && stats.forwardPe?.length) pe.ahead = peAhead(pe, stats.forwardPe);
    // ... and on the last profit reported
    const lead = parts.length ? '' : 'price/earnings ';
    if (lastY) { if (mcapUsd && lastY.netIncome > 0) { stats.pe = mcapUsd / lastY.netIncome; stats.peYear = lastY.period.slice(0, 4); } }
    else if (usFigures && pe?.now != null) { stats.pe = pe.now; stats.peYear = pe.basis; }
    else if (last != null && ev.actual?.eps > 0) { stats.pe = last / ev.actual.eps; stats.peYear = ev.actual.label; }
    // onvista's own P/E: the last year's only - an older one is stale (Neo: 2021's, after a loss in 2025)
    else if (ov?.per && !(ev.actual?.eps <= 0)) { stats.pe = ov.per; stats.peYear = `${ov.label}, onvista`; }
    if (stats.pe != null) parts.push(`${lead}${n0(stats.pe)} on the ${stats.peYear} profit reported`);
    if (own?.perShare > 0 && last != null) {
      stats.ownPe = last / own.perShare;
      parts.push(`${n0(stats.ownPe)} on its own measure (${own.label}, ${own.period}: ${n2(own.perShare)} € a share)`);
    }
    if (mcapUsd && lastY?.revenue) { stats.ps = mcapUsd / lastY.revenue; parts.push(`price/sales ${n1(stats.ps)}`); }
    // enterprise value (market value + debt − cash) ÷ EBITDA: P/E for a company whose profit is eaten by write-downs
    // over 100: Yahoo mixing units (ASML's ADR: 2.855) or an EBITDA near nothing - says nothing either way
    if (an.targets?.evEbitda > 0 && an.targets.evEbitda <= 100) { stats.evEbitda = an.targets.evEbitda; parts.push(`EV/EBITDA ${n1(stats.evEbitda)} (Yahoo)`); }
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
    // Nasdaq's for US ISINs; else onvista's, or on Yahoo's estimates P/E on them ÷ the outlook's growth.
    // Not where the estimates measure another profit than the reported EPS
    const fpe = stats.ntmPe ?? stats.forwardPe?.[0]?.pe ?? null;
    const peg = usFigures ? us?.peg?.value ?? null : ev.otherBasis ? null
      : ev.ahead[0]?.source === 'Yahoo' ? (fpe > 0 && stats.expectedGrowth > 0 ? fpe / stats.expectedGrowth : null)
      : an.annual.find(r => r.estimate && r.peg != null)?.peg ?? null;
    if (peg > 0) { stats.peg = peg; parts.push(`PEG ${n2(peg)}`); }
    const eg = usFigures ? us?.peg?.growth ?? [] : [];
    const mc = mcapUsd ? `${big(mcapUsd)} $` : `${big(an.profile.marketCap)} ${cur(an.profile.marketCapCurrency)}`;
    // earnings yield: what a year of (estimated) profit pays on the price, against a safe 10-year bond
    if (fpe > 0) stats.earningsYield = 100 / fpe;
    if (pe) stats.peMedian = pe.median;
    add('Valuation', lastY?.netIncome < 0 ? 'bad' : 'neutral',
      `Market value ${mc}${parts.length ? `; ${parts.join('; ')}` : ''}.`
      + `${eg.length ? ` Analysts expect earnings per share ${eg.map(g => `${pct(g.pct)} in ${g.year}`).join(', ')}.` : ''}`
      + `${!usFigures && ev.otherBasis ? ` The estimates (${n2(ev.ahead[0].eps)} € for ${ev.ahead[0].label}) are ${n1(ev.ratio)}× the reported ${n2(ev.actual.eps)} € (${ev.actual.label}) - a big jump, or another measure of profit (adjusted, before one-offs) - so compare P/E on estimates only with P/E on estimates.` : ''}`
      + `${stats.earningsYield != null && bond != null ? ` On the estimates it earns ${n1(stats.earningsYield)} % of its price a year; 10-year euro bonds pay ${n1(bond)} %.` : ''}`
      + `${pe ? ` Against its own past: P/E ${pe.now != null ? n0(pe.now) : 'over 100'} now, ${n0(pe.median)} in the middle since ${day(pe.since)} (yearly profit${pe.nasdaq.length ? `, ${pe.nasdaq.join(', ')} from Nasdaq` : ''}).` : ''}`,
      'red: no profit to measure against · otherwise not judged - compare with peers. PEG = P/E ÷ expected earnings growth: near 1, the price matches the growth',
      stats.forwardPe?.length ? `P/E ${n0(stats.forwardPe[0].pe)} on ${stats.forwardPe[0].year} est.${stats.pe != null ? ` · ${n0(stats.pe)} on ${stats.peYear}` : ''}`
        : stats.pe != null ? `P/E ${n0(stats.pe)} on ${stats.peYear}` : `worth ${mc}`);
  }

  // three investors' tests, by their published rules; per share, in the listing's currency
  const shares = (mcapUsd && priceUsd ? mcapUsd / priceUsd : null) || an.profile?.shares || null;
  // book value a share: onvista's for the year filed (every share class), else shareholders' equity in euros at the ECB rate
  const bookEur = eqShare > 0 ? eqShare : fy?.equity > 0 && an.profile?.shares ? toEur(fy.equity, fy.currency) / an.profile.shares : null;
  investors(an, { ly: usFigures && !usStale ? ly : null, last, priceUsd, shares, stats, add, today, ev, ebitMargin, kind, bookEur });

  // analysts (US-listed only)
  const at = us?.analysts;
  if (at) {
    const n = at.buy + at.hold + at.sell;
    add('Analysts', at.upside >= 15 && at.buy > n / 2 ? 'good' : at.upside < 0 || at.sell > at.buy ? 'bad' : 'neutral',
      `${at.buy} buy, ${at.hold} hold, ${at.sell} sell. Average target ${n2(at.target)} $ (${pct(at.upside)} vs ${n2(at.price)} $), range ${n0(at.low)}–${n0(at.high)} $.`,
      'green: most say buy and the target is 15 % or more above · red: target below the price or more sells than buys',
      `${at.buy} of ${n} buy · target ${pct(at.upside)}`);
  } else if (yt && last != null) {
    const up = (yt.target / yt.price - 1) * 100, eur = v => n2(last * v / yt.price), few = !(yt.analysts >= 3);
    const rec = yt.recommendation ?? '', an1 = `${yt.analysts ?? '?'} analyst${yt.analysts === 1 ? '' : 's'}`;
    add('Analysts', few ? 'neutral' : up >= 15 && /buy/.test(rec) ? 'good' : up < 0 || /sell|underperform/.test(rec) ? 'bad' : 'neutral',
      `${an1}${rec ? `, on average "${rec}"` : ''}. Average target ${eur(yt.target)} € (${pct(up)}), range ${eur(yt.low)}–${eur(yt.high)} € - `
      + `Yahoo${yt0.currency === 'EUR' ? '' : `, in euros at today's price${yt0.currency ? ` (theirs in ${yt0.currency})` : ''}`}.${few ? ' Fewer than 3 analysts: not judged.' : ''}`,
      'green: on average they say buy and the target is 15 % or more above · red: target below the price, or on average they say sell. Fewer than 3 analysts: not judged',
      `${an1} · target ${pct(up)}`);
  } else if (file?.analysts && last != null) {
    // the ratings saved in its company file: each firm's latest of the last 12 months
    const A = file.analysts, up = A.target > 0 ? (A.target / last - 1) * 100 : null, few = A.n < 3, L = A.latest;
    add('Analysts', few ? 'neutral' : up != null && up >= 15 && A.buy > A.n / 2 ? 'good' : (up != null && up < 0) || A.sell > A.buy ? 'bad' : 'neutral',
      `${A.buy} buy, ${A.hold} hold, ${A.sell} sell - ${A.n} firm${A.n === 1 ? '' : 's'}' latest rating since ${day(A.since)}.`
      + `${up != null ? ` Average target ${n2(A.target)} € (${pct(up)}), range ${n2(A.low)}–${n2(A.high)} €${A.targets < A.n ? ` (${A.targets} with a target)` : ''}.` : ''}`
      + ` Latest: ${L.firm} ${L.ratingText ?? L.rating}${L.target ? `, target ${n2(L.target)} ${sym(L.currency)}` : ''} on ${day(L.date)}. From its company file.${few ? ' Fewer than 3 firms: not judged.' : ''}`,
      'green: most say buy and the target is 15 % or more above · red: target below the price or more sells than buys. Fewer than 3 firms: not judged',
      `${A.buy} of ${A.n} buy${up != null ? ` · target ${pct(up)}` : ''}`);
  }

  // who buys and sells: insiders (Nasdaq's Form 4 for US ISINs, BaFin's directors' dealings for German
  // issuers), short sellers, funds (shares listed in the US)
  const ins = us?.insiders ?? an.insiders ?? file?.insiders;
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
      + `${ins.source === 'BaFin' ? ' (BaFin directors\' dealings)' : ins.source ? ` (from ${ins.source}${ins.plans ? `; ${ins.plans} grants and plan trades in 12 months left out` : ''})` : ''}`,
      'green: insiders bought more often than they sold (3 months) · red: they sold and did not buy. Sales under a pre-set plan say less than a buy',
      `${sells} sold, ${buys} bought · 3 months`);
  }
  // public people who bought it: members of the US Congress (their reports; nothing like them in Europe) - only when some did
  const cb = an.congress ?? [], fp = file?.politicians ?? [];
  if (cb.length || fp.length) {
    const who = [...new Set(cb.map(b => b.member).concat(fp.map(d => d.person)))];
    const verb = t => ({ buy: 'bought', sell: 'sold', grant: 'was granted', exercise: 'exercised' }[t] ?? 'traded');
    add('Politicians', 'neutral',
      `${cb.length ? `Members of the US Congress who bought it, last 3 months: ${cb.slice(0, 6).map(b => `${b.member} (${b.chamber}${b.state ? `, ${b.state}` : ''})`
        + ` ${b.amount ?? ''} on ${day(b.date)}${b.disclosed ? `, reported ${day(b.disclosed)}` : ''}`).join('; ')}${cb.length > 6 ? `; and ${cb.length - 6} more` : ''}.`
      + ' Amounts as filed, in ranges; a report can come up to 45 days after the trade. Source: Bargo (bargo.ai), from the House\'s and the Senate\'s filings.' : ''}`
      + `${fp.length ? `${cb.length ? ' ' : ''}From its company file, last 12 months: ${fp.slice(0, 6).map(d => `${d.person}${d.role ? ` (${d.role})` : ''} ${verb(d.type)}`
        + `${d.amount ? ` ${d.amount}` : d.shares ? ` ${big(d.shares)} shares` : ''} on ${day(d.date)}`).join('; ')}${fp.length > 6 ? `; and ${fp.length - 6} more` : ''}.` : ''}`,
      '', `${who.slice(0, 2).join(', ')}${who.length > 2 ? ` +${who.length - 2}` : ''} ${fp.every(d => d.type === 'buy') ? 'bought' : !cb.length && fp.every(d => d.type === 'sell') ? 'sold' : 'traded'}`);
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
  // who holds it, as disclosed (stakes over the reporting thresholds) - saved in its company file
  const hs = file?.holders ?? [];
  if (hs.length) {
    const top = hs.slice(0, 6), sum = hs.filter(h => h.kind !== 'treasury').reduce((s, h) => s + h.pct, 0);
    add('Holders', 'neutral',
      `Largest disclosed holders: ${top.map(h => `${h.name} ${n1(h.pct)} %${h.kind === 'treasury' ? ' (own shares)' : h.kind === 'state' ? ' (state)' : ''} (${day(h.date)})`).join(', ')}${hs.length > 6 ? `, and ${hs.length - 6} more` : ''}.`
      + ` Together ${n0(sum)} % outside its own shares. From its company file.`, '', `${top[0].name} ${n1(top[0].pct)} %`);
  }

  // the last quarters against what analysts expected, and what comes next - Yahoo's, in the company's currency
  const rq = results(E), c$ = sym(E?.currency);
  if (rq.judged >= 2) {
    Object.assign(stats, { beats: rq.beats, misses: rq.misses, quartersJudged: rq.judged });
    const show = rq.list.filter(q => q.epsSurprise != null).slice(-4);
    add('Results', rq.judged >= 3 && rq.beats >= 3 ? 'good' : rq.misses >= 2 ? 'bad' : 'neutral',
      `EPS against the analysts' estimate, last ${show.length} quarters: ${show.map(q => `${quarter(q.end)} ${n2(q.eps)} ${c$} vs ${n2(q.epsEstimate)} (${pct1(q.epsSurprise)})`).join(', ')}.`
      + `${rq.list.some(q => q.revenueSurprise != null) ? ` Revenue: ${rq.list.filter(q => q.revenueSurprise != null).slice(-4).map(q => `${quarter(q.end)} ${big(q.revenue)} ${c$} vs ${big(q.revenueEstimate)} (${pct1(q.revenueSurprise)})`).join(', ')}.` : ''}`
      + ' (Yahoo)',
      'green: beat the EPS estimate in 3 or more of the last 4 quarters · red: missed it in 2 or more. Most companies beat: a miss says more',
      `${rq.beats} beat, ${rq.misses} missed · ${rq.judged} quarters`);
  }
  // a date the company set (its company file, from its calendar) before Yahoo's guess
  const fileNext = file?.next?.date ?? null, ownDate = !us?.earningsDate && fileNext && (!E?.next?.date || E.next.estimated || E.next.date < today);
  const next = us?.earningsDate ?? (ownDate ? fileNext : E?.next?.date) ?? null, nq = E?.quarters?.[0];
  if (next && next >= today) {
    const days = Math.round((Date.parse(next) - Date.parse(today)) / 864e5), guess = !us?.earningsDate && !ownDate && E?.next?.estimated;
    const want = nq ? [nq.eps != null && `EPS ${n2(nq.eps)} ${c$}`, nq.revenue != null && `revenue ${big(nq.revenue)} ${c$}${nq.revenueGrowth != null ? ` (${pct(nq.revenueGrowth)} on a year before)` : ''}`].filter(Boolean) : [];
    add('Next results', 'neutral', `${day(next)}, in ${days} days${guess ? ' (Yahoo\'s guess, not yet set by the company)' : ownDate ? ` - ${file.next.title} (its company file)` : ''}.`
      + `${want.length ? ` Analysts expect ${want.join(' and ')} for the quarter to ${day(nq.end)} - ${by('Yahoo', nq.epsAnalysts ?? nq.revenueAnalysts)}.` : ''}`
      + ' The price often jumps on results day, both ways.', '', `${day(next)} · in ${days} days`);
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
  const bb = usFigures ? (ly?.stock < 0 && mcapUsd ? -ly.stock / mcapUsd * 100 : null)
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

  // the stage of the business, from three answers - is revenue growing, is there a profit, is money paid back -
  // and the two yardsticks that fit it: no P/E for a company without profit, no price/sales for one that pays out
  const sp = an.type === 'STOCK' ? stagePoint() : null;
  if (sp) { const at = points.findIndex(p => p.group === sp.group); points.splice(at < 0 ? points.length : at, 0, sp); }

  // bear, base and bull a year out, three ways - next to the stage, at the top of Valuation
  const sc = an.type === 'STOCK' ? scenarios({ closes, last, ud, pe, ev, today, shortPct: stats.shortPct, daysToCover: stats.daysToCover }) : null;
  if (sc) {
    const e0 = v => `${n0(v)} €`;
    const scp = { topic: 'Scenarios', group: groupOf('Scenarios'), tone: 'neutral',
      head: `base: ${sc.lenses.map(l => `${l.id === 'pe' ? 'own P/E' : l.id} ${pct(l.base)}`).join(' · ')}`,
      text: `A year from today's ${n2(last)} €, bear / base / bull: `
        + sc.lenses.map(l => `${l.label.toLowerCase()} ${pct(l.bear)} / ${pct(l.base)} / ${pct(l.bull)} (${l.prices.map(e0).join(' / ')}) - ${l.note}`).join('; ')
        + `.${sc.squeeze ? ` Squeeze possible: ${sc.squeeze.pct != null ? `${n1(sc.squeeze.pct)} % of the shares sold short` : ''}${sc.squeeze.days != null ? `, ${n1(sc.squeeze.days)} days of trading to buy them back` : ''} - a rise can force short sellers to buy, which lifts it further.` : ''}`,
      rule: 'Not coloured: three ways to look at a year ahead, none a forecast. Analysts: their price targets. Own P/E range: where its P/E has been for '
        + '3 years, on today\'s reported EPS grown as analysts expect. Past 1 year: what holding it a year did before - 10 % of outcomes worse than bear, '
        + '10 % better than bull. Squeeze: US-listed shares with 15 % or more sold short or 7+ days to cover' };
    const at = points.findIndex(p => p.group === scp.group && p.topic !== 'Stage');
    points.splice(at < 0 ? points.length : at, 0, scp);
  }
  function stagePoint() {
    const gRev = stats.revenueGrowth ?? null, gNext = stats.expectedRevenueGrowth ?? null, cy = cf?.years ?? [];
    // profit: the last year reported - its net income, else Yahoo's, else onvista's EPS
    const eps = an.annual.filter(r => !r.estimate && r.eps != null && r.eps !== 0 && yearEnd(r.label) && yearEnd(r.label) <= today);
    const P = stats.netIncome != null ? { now: stats.netIncome, before: yrs.at(-2)?.netIncome ?? null, label: yrs.at(-1).label, prior: yrs.at(-2)?.label, show: v => `${big(v)} ${cur(yrs.at(-1).c)}` }
      : cy.at(-1)?.netIncome != null ? { now: cy.at(-1).netIncome, before: cy.at(-2)?.netIncome ?? null, label: cy.at(-1).year, prior: cy.at(-2)?.year, show: v => `${big(v)} ${sym(cf.currency)}` }
      : eps.length ? { now: eps.at(-1).eps, before: eps.at(-2)?.eps ?? null, label: eps.at(-1).label, prior: eps.at(-2)?.label, show: v => `${n2(v)} € a share` } : null;
    if (!P && gRev == null && gNext == null) return null;
    // paid back a year, in % of the market value: the dividend (onvista's last two years, else Yahoo's paid, else
    // Nasdaq's last 12 months) and buybacks. Under 1 % is a token (Micron's dividend), not a stage
    const yearAgo = new Date(Date.parse(today) - 365 * 864e5).toISOString().slice(0, 10), usDiv = (us?.dividends ?? []).filter(d => d.exDate > yearAgo);
    const dy = dps?.dps > 0 && last && yearOf(dps.label) >= Number(today.slice(0, 4)) - 2 ? dps.dps / last * 100
      : cy.at(-1)?.dividendsPaid < 0 && mcapE ? toEur(-cy.at(-1).dividendsPaid, cf.currency) / mcapE * 100
      : usDiv.length && priceUsd ? usDiv.reduce((t, d) => t + d.amount, 0) / priceUsd * 100 : null;
    const backPct = (dy ?? 0) + (bb > 0 ? bb : 0), back = backPct >= 1;
    const parts = [dy > 0 && `dividend ${n1(dy)} %`, bb > 0 && `buybacks ${n1(bb)} %`].filter(Boolean);
    const shrinking = gRev != null ? gRev < 0 && !(gNext > 0) : gNext < 0;
    const lossBefore = P?.before != null && P.before < 0;
    const no = shrinking ? 5 : !P ? null : P.now <= 0 ? (lossBefore ? (P.now > P.before ? 2 : 1) : '1–2') : back ? 4 : 3;
    if (no == null) return null;
    const NAME = { 1: 'Startup', 2: 'Hyper growth', '1–2': 'Startup or hyper growth', 3: 'Operating leverage', 4: 'Capital return', 5: 'Decline' };

    // the next 12 months of an analysts' figure, blended from the two years they fall in, like the EPS
    const E0 = an.estimates, ntm = k => {
      const ys = (E0?.years ?? []).filter(y => y[k] > 0 && y.end > today).slice(0, 2);
      if (!ys.length) return null;
      const left = Math.min(1, Math.max(0, (Date.parse(ys[0].end) - Date.parse(today)) / (365.25 * 864e5)));
      return { v: ys[1] ? left * ys[0][k] + (1 - left) * ys[1][k] : ys[0][k], analysts: ys[0][`${k}Analysts`] ?? null };
    };
    // market value in the currency of the analysts' figures: Nasdaq's in dollars, else onvista's in euros at the ECB rate
    const mv = c => (c === 'USD' && mcapUsd ? mcapUsd : an.profile?.marketCap > 0 && (an.profile.marketCapCurrency ?? 'EUR') === 'EUR'
      ? c === 'EUR' ? an.profile.marketCap : rates?.fx?.[c] ? an.profile.marketCap * rates.fx[c] : null : null);
    const rev = ntm('revenue'), mvE = E0?.currency ? mv(E0.currency) : null;
    const ps = rev && mvE ? mvE / rev.v : null;
    // gross profit: Nasdaq's last four quarters, else its last year - shares listed in the US only
    const q4 = (us?.quarterly ?? []).slice(-4);
    const gpQ = q4.length === 4 && q4.every(q => q.grossProfit != null) && Date.parse(today) - Date.parse(q4[3].period) < 200 * 864e5
      ? q4.reduce((t, q) => t + q.grossProfit, 0) : null;
    const gp = kind ? null : gpQ ?? (!usStale && ly?.grossProfit > 0 ? ly.grossProfit : null);
    const pgp = mcapUsd && gp > 0 ? mcapUsd / gp : null;
    const fpe = stats.ntmPe ?? (ev.ntm > 0 && last != null && ev.ahead[0]?.source === 'Yahoo' ? last / ev.ntm : null);
    const fpeOn = fpe != null ? 'the next 12 months' : stats.forwardPe?.length ? `${stats.forwardPe[0].year} estimates` : null;
    const fpe1 = fpe ?? stats.forwardPe?.[0]?.pe ?? null;
    // free cash flow: the last year's - no analysts' estimate of it in our data; onvista's price/cash flow ahead beside it
    const pfcf = !kind && stats.fcfYield > 0 ? 100 / stats.fcfYield : null, fcfYear = ly?.operatingCashFlow != null ? lyl : cfy.at(-1)?.year;
    const pcfAhead = kind ? null : an.annual.find(r => r.estimate && r.pcf > 0 && (r.end ?? yearEnd(r.label)) > today);
    Object.assign(stats, { stage: `${no} ${NAME[no]}`, forwardPs: ps, priceGrossProfit: pgp, priceFcf: pfcf });

    // each yardstick: its short name, its value (null: none), the sentence
    const M = {
      ps: ['fwd P/S', ps, `price/sales ${ps != null ? `${n1(ps)} on the next 12 months' revenue (${by('Yahoo', rev.analysts)})` : '- no analysts\' revenue'}`],
      pgp: ['P/GP', pgp, `price/gross profit ${pgp != null ? `${n1(pgp)} on ${gpQ != null ? 'the last 4 quarters' : lyl}` : kind ? '- not for a bank or insurer' : '- gross profit only for shares listed in the US'}`],
      fpe: ['fwd P/E', fpe1, `P/E ${fpe1 != null ? `${n0(fpe1)} on ${fpeOn}` : '- no analysts\' EPS'}`],
      // on the company's own profit measure where it steers by one (Brookfield: distributable earnings), as the P/E chips do
      pe: ['P/E', stats.ownPe ?? stats.pe, stats.ownPe != null ? `P/E ${n0(stats.ownPe)} on its own measure (${own.label}, ${own.period})`
        : `P/E ${stats.pe != null ? `${n0(stats.pe)} on the ${stats.peYear} profit${pe?.median ? ` (its middle since ${pe.since.slice(0, 4)}: ${n0(pe.median)})` : ''}` : '- no profit reported'}`],
      fcf: ['P/FCF', pfcf, `price/free cash flow ${pfcf != null ? `${n1(pfcf)} on ${fcfYear}'s - no analysts' estimate of it here` : kind ? '- not for a bank or insurer' : stats.fcfYield <= 0 ? '- free cash flow negative' : '- no free cash flow figures'}`
          + `${pcfAhead ? `; onvista's price/cash flow from operations ${n1(pcfAhead.pcf)} on ${pcfAhead.label}` : ''}`],
    };
    const use = no === 4 ? ['pe', 'fcf'] : no === 3 || no === 5 ? ['fpe', 'fcf'] : ['ps', 'pgp'];
    // the first one ranks it among companies in the same stage (the Research chips' Stage group)
    Object.assign(stats, { stageBy: M[use[0]][0], stageValue: M[use[0]][1] ?? null });
    const short = ([label, v]) => `${label} ${v == null ? '–' : label.endsWith('P/E') ? n0(v) : n1(v)}`;
    const grow = [gRev != null && `${pct(gRev)} in ${stats.revenueYear}`, gNext != null && `${pct(gNext)} expected for ${revs[0].label}`].filter(Boolean);
    const profit = !P ? 'no profit figures' : P.now > 0 ? `profit ${P.show(P.now)} in ${P.label}`
      : `loss ${P.show(-P.now)} in ${P.label}${lossBefore ? `, ${P.now > P.before ? 'smaller' : 'larger'} than in ${P.prior}` : P.before > 0 ? `, after a profit in ${P.prior}` : ''}`;
    return { topic: 'Stage', group: groupOf('Stage'), tone: 'neutral',
      head: [`${no} ${NAME[no]}`, ...use.map(k => short(M[k]))].join(' · '),
      text: `Stage ${no} of 5, ${NAME[no].toLowerCase()}: revenue ${grow.length ? grow.join(', ') : 'without figures'}; ${profit}; `
        + `${!parts.length ? 'pays nothing back' : `pays ${n1(backPct)} % of its market value back a year (${parts.join(', ')})`
          + `${P?.now <= 0 ? ' despite the loss' : ''}${back ? '' : ' - a token'}`}.`
        + ` The yardsticks for this stage: ${use.map(k => M[k][2]).join('; ')}. Compare them with companies in the same stage.`,
      rule: 'Not coloured: the stage says which numbers to compare, not whether it is cheap. 1 Startup and 2 Hyper growth: a loss - 2 when it is smaller than'
        + ' the year before - judged on price/sales on the next 12 months and price/gross profit · 3 Operating leverage: a profit, under 1 % paid back -'
        + ' P/E on the next 12 months and price/free cash flow · 4 Capital return: a profit, and dividend + buybacks of 1 % of the market value a year or more -'
        + ' P/E on the last year and price/free cash flow · 5 Decline: revenue down and analysts expect no growth - P/E on the next 12 months and'
        + ' price/free cash flow. Free cash flow: the last year\'s, as no analysts\' estimate of it is in our data' };
  }

  const ceo = an.profile?.ceo, fc = file?.ceo;
  if (ceo?.name || fc) {
    const same = fc && ceo?.name && bareName(fc.name).split(' ').at(-1) === bareName(ceo.name).split(' ').at(-1);
    const own = fc ? `${fc.since ? ` Since ${/^\d{4}$/.test(fc.since) ? fc.since : day(fc.since)}.` : ''}`
      + `${fc.pay != null ? ` Paid ${big(fc.pay)} €${fc.payYear ? ` for ${fc.payYear}` : ''}${fc.payNote ? ` (${fc.payNote})` : ''}.` : ''}`
      + `${fc.shares != null ? ` Holds ${big(fc.shares)} shares${last != null ? ` (≈ ${big(fc.shares * last)} € at today's price)` : ''}${fc.sharesAt ? ` on ${day(fc.sharesAt)}` : ''}.` : ''}` : '';
    add('Management', 'neutral', (
      `${ceo?.name ? `CEO ${ceo.name}${ceo.payRatio ? `, paid ${n0(ceo.payRatio)}× the company's median employee` : ''} (onvista, from its sustainability reporting).` : ''}`
      + `${fc ? `${ceo?.name && !same ? ` Its company file names ${fc.name} (${fc.role}).` : !ceo?.name ? ` ${fc.role} ${fc.name}.` : ''} ${own.trim()}${own ? ' (its company file)' : ''}` : ''}`).replace(/\s+/g, ' ').trim(),
      '', `${fc && !ceo?.name ? fc.role : 'CEO'} ${ceo?.name ?? fc.name}${fc?.since ? ` · since ${fc.since.slice(0, 4)}` : ''}`);
  }

  // contracts it announced: not judged - what it won, to set against its revenue and backlog
  const C = file?.contracts;
  if (C?.all) {
    const v = x => (x.value != null ? `${n1(x.value)} ${x.unit === 'bn' ? 'bn' : 'm'} ${sym(x.currency)}` : 'value not disclosed');
    add('Contracts', 'neutral',
      `${C.n ? `Announced in the last 12 months: ${C.n} contract${C.n === 1 ? '' : 's'} and agreement${C.n === 1 ? '' : 's'}${C.priced ? `, ${C.priced} with a value: ≈ ${big(C.eur)} € in all` : ''}.` : 'No contract announced in the last 12 months.'}`
      + `${C.largest.length ? ` Largest: ${C.largest.map(x => `${x.customer ? `${x.customer} - ` : ''}${x.what} (${v(x)}, ${day(x.date)})`).join('; ')}.` : ''}`
      + `${C.pending.length ? ` Pending: ${C.pending.map(x => `${x.kind === 'acquisition' && x.customer ? `buying ${x.customer}` : x.what} (${v(x)})`).join('; ')}.` : ''}`
      + ` From its company file (${C.all} saved).`,
      'Not judged: what it says it won, as announced. Set it against its revenue and order backlog (Company numbers). Values as announced, in euros at today\'s ECB rate',
      C.n ? `${C.n} in 12 months${C.priced ? ` · ≈ ${big(C.eur)} €` : ''}` : 'none in 12 months');
  }

  // where it trades, and in which currency: its main listing, where most of its shares trade
  const main = an.profile?.currency, venue = an.profile?.venue;
  if (usIsin && an.profile?.country && an.profile.country !== 'USA') {
    add('Listing', 'neutral', `A US-listed share (ADR) of a company from ${an.profile.country}. It trades in dollars: in euros your result also moves with EUR/USD.`, '', 'ADR in US dollars');
  } else if (usIsin) {
    add('Listing', 'neutral', 'Trades in dollars: in euros your result also moves with EUR/USD.', '', 'in US dollars');
  } else if (main === 'USD') {
    add('Listing', 'neutral', `Trades mainly ${us?.listedAs ? `as ${us.listedAs} ` : ''}${venue ? `on ${venue}` : 'in the US'}, in dollars, though the company is from ${an.profile?.country ?? 'abroad'}: in euros your result also moves with EUR/USD.`
      + `${us?.listedAs ? ' Analysts, funds and short interest come from that listing.' : ''}`, '', 'in US dollars');
  } else if (main && main !== 'EUR') {
    add('Listing', 'neutral', `Trades mainly ${venue ? `on ${venue}` : 'abroad'}, in ${main}: in euros your result also moves with the exchange rate.`
      + `${us?.listedAs ? ` Also trades in New York as ${us.listedAs}: analysts, funds and short interest come from that listing.` : ''}`, '', `in ${main}`);
  } else if (us?.listedAs) {
    add('Listing', 'neutral', `Also trades in New York as ${us.listedAs}${us.market?.exchange ? ` (${us.market.exchange})` : ''}, in dollars: analysts, funds and short interest here come from that listing.`
      + `${fy?.currency && fy.currency !== 'EUR' ? ` Its figures are in ${fy.currency}: in euros your result also moves with the exchange rate.` : ''}`, '', `also ${us.listedAs} in the US`);
  }

  // what the read-out stands on, and how fresh it is
  const asOf = [
    quote?.venue ? `price ${quote.venue}${quote.at ? ` ${day(quote.at)}` : ''}` : null,
    fy?.end ? `last year filed to ${day(fy.end)}${fy.standard ? ` (${fy.standard})` : ''}` : ov ? `financials to ${ov.label}` : null,
    ev.ahead.length ? `estimates (${ev.ahead[0].source}) to ${ev.ahead.at(-1).label}` : null,
    us ? `Nasdaq${us.listedAs ? ` (US listing ${us.listedAs})` : ''}` : null,
    own ? `company numbers to ${own.period.split('–').at(-1)}` : null,
    file?.updated ? `company file ${day(file.updated)}` : null,
    F?.asOf ? `fund data onvista to ${day(F.asOf)}` : null,
    rates?.date ? `ECB rates ${day(rates.date)}` : null,
  ].filter(Boolean);
  if (asOf.length) add('Data', 'neutral',
    `${stats.stale ? `The financials end in ${stats.stale} (onvista) - newer years are missing here. ` : ''}Based on: ${asOf.join(' · ')}.`, '',
    stats.stale ? `financials end ${stats.stale}` : fy?.label ? `filed to ${fy.label}` : 'sources');
  const dp0 = points.find(p => p.topic === 'Data');
  if (F && dp0) dp0.group = 'fund';
  if (usStale && dp0) dp0.text += ` Nasdaq's last full year ends ${day(usLast.period)}, onvista already has ${ev.actual.label}: the newer one is used.`;

  const fit = depot ? fitIn(depot, an, amount) : null;
  const dp = fit && depotPoint(fit, an, amount);
  if (dp) points.push(dp);
  return { points, groups: GROUPS, fit, themes: th, stats, pe, upDown: ud, holds: hold, scenarios: sc };
}

/**
 * Up and down from today's price, from the numbers alone. Up: to the analysts' average target - in the
 * listing's currency, carried to euros by its ratio to their price, so the % stays theirs. Down: to the 200-day average,
 * where the trend would break, or to the 52-week low when the price is already under it. Plus the last
 * year of closes and the 200-day average by day, for the chart.
 *   -> { dates, close, ma200, up, target, low, high, down, level, downTo, ratio, analysts } or null
 */
export function upDown(closes, last, stats, analysts, today) {
  if (last == null || closes.length < 20) return null;
  const at = analysts?.target > 0 && analysts.price > 0 ? analysts : null;              // { target, low, high, price, n }
  const eur = v => (v > 0 ? last * v / at.price : null);
  const up = at ? (at.target / at.price - 1) * 100 : null;
  const [level, downTo] = stats.ma200 != null && last > stats.ma200 ? [stats.ma200, '200-day average']
                        : stats.low52 != null && last > stats.low52 ? [stats.low52, '52-week low'] : [null, null];
  const down = level != null ? (level / last - 1) * 100 : null;
  if (up == null && down == null) return null;
  const from = new Date(Date.parse(today) - 365 * 864e5).toISOString().slice(0, 10);
  let sum = 0;
  const ma = closes.map(([, v], i) => { sum += v - (i >= 200 ? closes[i - 200][1] : 0); return i >= 199 ? sum / 200 : null; });
  const keep = closes.flatMap(([d], i) => (d >= from ? [i] : []));
  return { dates: keep.map(i => closes[i][0]), close: keep.map(i => closes[i][1]), ma200: keep.map(i => ma[i]),
           up, target: at ? eur(at.target) : null, low: at ? eur(at.low) : null, high: at ? eur(at.high) : null,
           down, level, downTo, ratio: up != null && down != null ? Math.max(0, up) / -down : null, analysts: at?.n ?? null };
}

/**
 * Bear, base and bull a year from today, three ways - lenses on the numbers, not a forecast:
 *   analysts  their lowest, average and highest price target (upDown's, in euros at today's price)
 *   pe        its own P/E over the last 3 years - 10 % of days lower, the middle, 10 % higher - times today's
 *             reported EPS grown by the analysts' EPS growth a year. The growth runs from estimate to estimate,
 *             so an adjusted EPS never meets a P/E on reported profit (Adobe: 24,5 $ adjusted, about 18 $ reported)
 *   past      bought on any day of the last 10 years and held one year: 10 % of outcomes worse, the middle, 10 % better
 * Each in % from today, with the prices. squeeze: shares listed in the US with 15 % or more sold short, or 7 days or
 * more of trading to buy them back - a flag, no price.
 *   -> { last, lenses: [{ id, label, bear, base, bull, prices: [bear, base, bull] €, note, extra }], squeeze } or null
 */
export function scenarios({ closes = [], last, ud = null, pe = null, ev = null, today, shortPct = null, daysToCover = null }) {
  if (!(last > 0)) return null;
  const q = (s, p) => s[Math.round(p * (s.length - 1))];
  const of = v => (v / last - 1) * 100, lenses = [];
  const lens = (id, label, prices, note, extra = {}) => lenses.push({ id, label, bear: of(prices[0]), base: of(prices[1]), bull: of(prices[2]), prices, note, ...extra });
  if (ud?.target > 0 && ud.low > 0 && ud.high > 0)
    lens('analysts', 'Analysts', [ud.low, ud.target, ud.high],
      `their lowest, average and highest price target${ud.analysts != null ? ` (${ud.analysts} analyst${ud.analysts === 1 ? '' : 's'}${ud.analysts < 3 ? ' - fewer than 3' : ''})` : ''}`,
      { analysts: ud.analysts ?? null });
  // EPS growth a year between the analysts' first and last year ahead - both on their basis
  const yr = 365.25 * 864e5, A = ev?.ahead ?? [], a0 = A[0], a1 = A.at(-1);
  const span = a0 && a1 && a1 !== a0 ? (Date.parse(a1.end) - Date.parse(a0.end)) / yr : 0;
  const g = span > 0.5 && a0.eps > 0 && a1.eps > 0 ? (a1.eps / a0.eps) ** (1 / span) - 1 : null;
  const from3 = new Date(Date.parse(today) - 3 * yr).toISOString().slice(0, 10);
  const pes = (pe?.dates ?? []).flatMap((d, i) => (d >= from3 && pe.values[i] != null ? [pe.values[i]] : [])).sort((x, y) => x - y);
  if (pe?.now > 0 && pes.length >= 60) {
    const eps = last / pe.now * (1 + (g ?? 0));
    lens('pe', 'Own P/E range', [q(pes, 0.1), q(pes, 0.5), q(pes, 0.9)].map(p => p * eps),
      `its P/E over the last 3 years (${n0(q(pes, 0.1))} / ${n0(q(pes, 0.5))} / ${n0(q(pes, 0.9))}) on today's reported EPS`
      + (g != null ? `, grown ${pct1(g * 100)} as analysts expect a year` : ', unchanged - no growth from analysts'),
      { pe: [q(pes, 0.1), q(pes, 0.5), q(pes, 0.9)], growth: g != null ? g * 100 : null });
  }
  // bought on any day, held one year (closes in euros: the currency's moves included)
  const later = d => `${Number(d.slice(0, 4)) + 1}${d.slice(4)}`, outs = [];
  for (let i = 0, j = 0; i < closes.length; i++) {
    const until = later(closes[i][0]);
    while (j < closes.length && closes[j][0] < until) j++;
    if (j >= closes.length) break;
    outs.push(closes[j][1] / closes[i][1]);
  }
  if (outs.length >= 250) {
    const s = [...outs].sort((x, y) => x - y), up = outs.filter(x => x > 1).length / outs.length * 100;
    lens('past', 'Past 1 year', [q(s, 0.1), q(s, 0.5), q(s, 0.9)].map(x => last * x),
      `bought on any day since ${day(closes[0][0])} and held a year: ${n0(up)} % ended with a gain, worst ${pct(s[0] * 100 - 100)}, best ${pct(s.at(-1) * 100 - 100)}`,
      { up, worst: (s[0] - 1) * 100, best: (s.at(-1) - 1) * 100, from: closes[0][0] });
  }
  const squeeze = shortPct >= 15 || daysToCover >= 7 ? { pct: shortPct, days: daysToCover } : null;
  return lenses.length ? { last, lenses, squeeze } : null;
}

/**
 * One number per group and one for all: the share of judged points that speak for the stock, 0-100.
 * Facts (grey) don't count, nor "In your depot" - that one is about your buy, not the stock.
 *   -> { score, good, bad, groups: [{ id, label, score, good, bad }] } - groups without a judged point left out
 */
export function score(points, groups) {
  const judge = ps => { const good = ps.filter(p => p.tone === 'good').length, bad = ps.filter(p => p.tone === 'bad').length;
                        return { score: good + bad ? Math.round(good / (good + bad) * 100) : null, good, bad }; };
  const own = points.filter(p => p.topic !== 'In your depot');
  return { ...judge(own), groups: groups.map(g => ({ id: g.id, label: g.label, ...judge(own.filter(p => p.group === g.id)) })).filter(g => g.good + g.bad) };
}

/**
 * Bought on any day, held 1, 3 or 5 years: what 1 € became. Payouts go back in on their day (a distributing
 * fund's price drops by what it pays out); one in a currency without a rate is left out and counted in `missed`.
 * Per span: the days it could start, the share that ended with a gain, worst / middle / best with the day bought,
 * and bins for a histogram - edges on multiples of `step`, so 1 (no change) is always an edge. Plus each calendar
 * year's change, close of the year before to close of the year (the current one so far).
 *   -> { from, missed, years: [{ year, pct, partial }], spans: [{ years, n, up, worst, worstOn, mid, best, bestOn,
 *        step, bins: [{ lo, n }] }] } or null
 */
export function holds(closes, payouts = [], toEur = (v, c) => (c === 'EUR' ? v : null)) {
  if (closes.length < 60) return null;
  const pay = [...payouts].sort((a, b) => a.date.localeCompare(b.date));
  let f = 1, k = 0, missed = 0;
  while (k < pay.length && pay[k].date <= closes[0][0]) k++;          // paid before the first close: not in the series
  const tr = closes.map(([d, v], i) => {
    for (; k < pay.length && pay[k].date <= d; k++) {
      const a = toEur(pay[k].amount, pay[k].currency);
      if (a == null) missed++; else f *= 1 + a / closes[i - 1][1];
    }
    return [d, v * f];
  });
  const later = (d, y) => `${Number(d.slice(0, 4)) + y}${d.slice(4)}`;
  const STEPS = [0.005, 0.01, 0.02, 0.025, 0.05, 0.1, 0.2, 0.25, 0.5, 1];   // 1 ÷ each is whole
  const spans = [1, 3, 5].map(years => {
    const out = [];
    for (let i = 0, j = 0; i < tr.length; i++) {
      const until = later(tr[i][0], years);
      while (j < tr.length && tr[j][0] < until) j++;
      if (j >= tr.length) break;
      out.push([tr[i][0], tr[j][1] / tr[i][1]]);
    }
    if (out.length < 20) return null;
    const v = out.map(o => o[1]).sort((a, b) => a - b);
    const lo = out.reduce((a, o) => (o[1] < a[1] ? o : a)), hi = out.reduce((a, o) => (o[1] > a[1] ? o : a));
    const step = STEPS.find(s => s >= (v.at(-1) - v[0]) / 24) ?? 1, at = x => Math.floor(x / step + 1e-9);
    const bins = Array.from({ length: at(v.at(-1)) - at(v[0]) + 1 }, (_, i) => ({ lo: Math.round((at(v[0]) + i) * step * 1e6) / 1e6, n: 0 }));
    for (const x of v) bins[at(x) - at(v[0])].n++;
    return { years, n: out.length, up: out.filter(o => o[1] > 1).length / out.length * 100,
             worst: lo[1], worstOn: lo[0], mid: v[v.length >> 1], best: hi[1], bestOn: hi[0], step, bins };
  }).filter(Boolean);
  const ends = new Map(tr.map(([d, v]) => [d.slice(0, 4), v])), ys = [...ends.keys()];
  const years = ys.slice(1).map((y, i) => ({ year: y, pct: (ends.get(y) / ends.get(ys[i]) - 1) * 100,
                                              partial: i === ys.length - 2 && tr.at(-1)[0] < `${y}-12-20` }));
  return { from: tr[0][0], missed, years, spans };
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
  // reported years: analysis.mjs flags a year an estimate until it is filed
  const actual = an.annual.filter(r => !r.estimate && end(r.label) && end(r.label) <= closes.at(-1)[0]);
  let yrs;
  if (an.isin?.startsWith('US') || an.us?.usFiler) {
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
 * The P/E line on into the analysts' years: the price ÷ their EPS, blended in a straight line from
 * the line's last day to each year end like the line itself - where the P/E goes if the price stays.
 * Points as far apart as the line's, so a year ahead takes the room of a year behind. None above 100.
 *   forward  [{ year, pe }] - the readout's P/E on estimates
 *   -> { dates, values, knots: [{ i, year, pe }] } or null
 */
export function peAhead(pe, forward) {
  const from = pe?.dates.at(-1);
  if (!from || pe.dates.length < 2) return null;
  const knots = forward.map(f => ({ year: f.year, end: yearEnd(f.year), pe: f.pe }))
    .filter((k, i, all) => k.end > from && k.pe > 0 && (i === 0 || k.end > all[i - 1].end));
  if (!knots.length) return null;
  const gap = (Date.parse(from) - Date.parse(pe.dates[0])) / (pe.dates.length - 1);
  const dates = [], values = [], out = [];
  // earnings yield (EPS ÷ price) moves in a straight line when only the EPS does; null: a loss or over 100 now
  let a = { end: from, ey: pe.values.at(-1) > 0 ? 1 / pe.values.at(-1) : null };
  for (const k of knots) {
    const t0 = Date.parse(a.end), t1 = Date.parse(k.end), n = Math.max(1, Math.round((t1 - t0) / gap)), ey = 1 / k.pe;
    for (let j = 1; j <= n; j++) {
      const v = a.ey == null ? (j === n ? k.pe : null) : 1 / (a.ey + (ey - a.ey) * j / n);
      dates.push(new Date(t0 + (t1 - t0) * j / n).toISOString().slice(0, 10));
      values.push(v != null && v <= 100 ? v : null);
    }
    out.push({ i: dates.length - 1, year: k.year, pe: k.pe });
    a = { end: k.end, ey };
  }
  return { dates, values, knots: out };
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
    add('Buffett', passed >= known.length - 1 && passed >= 3 ? 'good' : known.length >= 3 && passed <= known.length / 2 ? 'bad' : 'neutral',
      `${passed} of ${known.length} checks passed${known.length < bChecks.length ? `, ${bChecks.length - known.length} without data` : ''}${known.length < 3 ? ' - too few to judge' : ''}. Buffett published no formula: these are the checks commonly drawn from his letters - returns, pricing power, little debt, steady profit and cash.`,
      `Buffett published no formula: checks commonly drawn from his letters. Green: all, or all but one (3 or more) · red: half or fewer · under 3 with data: not judged. "?" = no data for it`,
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
    add('Ackman', aPassed >= aKnown.length - 1 && aPassed >= 3 ? 'good' : aKnown.length >= 3 && aPassed <= aKnown.length / 2 ? 'bad' : 'neutral',
      `${aPassed} of ${aKnown.length} checks passed${aKnown.length < aChecks.length ? `, ${aChecks.length - aKnown.length} without data` : ''}${aKnown.length < 3 ? ' - too few to judge' : ''}. Pershing Square's stated criteria: simple, predictable,`
      + ' free-cash-flow generative, barriers to entry, a strong balance sheet, an attractive price - plus two no number can test: little exposure to outside forces, and good management.',
      'Ackman published criteria, not a formula: these are the measurable ones. Green: all, or all but one (3 or more) · red: half or fewer · under 3 with data: not judged. "?" = no data for it',
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

/**
 * Weights and the mix by position, sector and country before and after buying `amount` euros of this stock.
 * A fund counts by what it holds: its countries, sectors and share in US dollars by weight.
 */
export function fitIn(depot, an, amount) {
  const cents = Math.round((Number(amount) || 0) * 100);
  const one = v => [[v || 'Unknown', 1]];
  const spread = list => { const t = list.reduce((s, x) => s + x.pct, 0); return list.map(x => [x.name, x.pct / t]); };
  const F = an.fund, look = F?.countries?.length ? {
    country: spread(F.countries), sector: F.sectors?.length ? spread(F.sectors) : one(null),
    usd: (F.currencies?.find(c => c.name === 'USD')?.pct ?? 0) / 100 } : null;
  const usd = (home, key) => (home !== undefined ? home === 'USD' : /^US/.test(key)) ? 1 : 0;   // its main listing's currency, else by ISIN
  const pos = depot.positions.map(p => ({ key: p.key, name: p.name, value: p.value, country: one(p.country), sector: one(p.sector), usd: usd(p.home, p.key),
                                          ...(look && p.key === an.key ? look : {}) }));
  let me = pos.find(p => p.key === an.key);
  const before = pos.map(p => ({ ...p }));
  if (!me) pos.push(me = { key: an.key, name: an.name, value: 0, country: one(an.profile?.country), sector: one(an.profile?.sector), usd: usd(an.profile?.currency ?? undefined, an.key), ...look });
  me.value += cents;
  const sum = list => list.reduce((s, p) => s + p.value, 0);
  const totalBefore = sum(before), totalAfter = sum(pos);
  const mix = (list, total, by) => {
    const m = new Map(); for (const p of list) for (const [k, w] of by(p)) m.set(k, (m.get(k) || 0) + p.value * w);
    return Object.fromEntries([...m].map(([k, v]) => [k, total ? v / total * 100 : 0]));
  };
  // share before -> after, grouped by `by`; `mine` marks the groups this stock is in
  const split = by => {
    const b = mix(before, totalBefore, by), a = mix(pos, totalAfter, by), mineK = new Set(by(me).map(([k]) => k));
    return [...new Set([...Object.keys(b), ...Object.keys(a)])]
      .map(k => ({ name: k, before: b[k] ?? 0, after: a[k] ?? 0, mine: mineK.has(k) })).sort((x, y) => y.after - x.after);
  };
  const names = new Map(pos.map(p => [p.key, p.name]));
  const countries = split(p => p.country).map(({ name, ...r }) => ({ country: name, ...r }));
  const sectors = split(p => p.sector).map(({ name, ...r }) => ({ sector: name, ...r }));
  const positions = split(p => [[p.key, 1]]).map(({ name, ...r }) => ({ key: name, name: names.get(name), ...r }));
  const top = pos.slice().sort((a, b) => b.value - a.value)[0];
  return {
    amount: cents, totalBefore, totalAfter, cash: depot.cash ?? null,
    weightBefore: totalBefore ? (before.find(p => p.key === an.key)?.value ?? 0) / totalBefore * 100 : 0,
    weightAfter: totalAfter ? me.value / totalAfter * 100 : 0,
    largestAfter: { key: top.key, name: top.name, weight: totalAfter ? top.value / totalAfter * 100 : 0 },
    countries, sectors, positions,
    usdBefore: totalBefore ? before.reduce((s, p) => s + p.value * p.usd, 0) / totalBefore * 100 : 0,
    usdAfter: totalAfter ? pos.reduce((s, p) => s + p.value * p.usd, 0) / totalAfter * 100 : 0,
  };
}
