/**
 * A company file: what is known about a company beyond its numbers - the contracts it won, who runs it,
 * what insiders and politicians traded, who holds it, what analysts say, what happened and what is coming.
 * The things no free feed carries for a European share (Nasdaq has insiders and analysts for US listings
 * only, BaFin directors' dealings for German issuers only). Data, so it lives in data/dossier/<ISIN>.json
 * (git-ignored, like everything in data/), filled by an agent through the MCP or by hand in the Research tab.
 * Every item names its source.
 *
 *   data/dossier/<ISIN>.json
 *     { company, isin, updated,
 *       contracts: [{ date, customer, what, value, unit: 'm'|'bn', currency, share, kind, delivery, status, segment, note, source }]
 *       people:    [{ name, role, since, background, pay, payYear, payNote, shares, sharesAt, source }]
 *       dealings:  [{ date, person, role, politician, type: buy|sell|grant|exercise|other, shares, price, currency, amount, plan, note, source }]
 *       holders:   [{ name, pct, date, kind, note, source }]
 *       ratings:   [{ date, firm, rating: buy|hold|sell, ratingText, target, previousTarget, currency, note, source }]
 *       events:    [{ date, title, kind, note, source }] }       a date ahead of today is a coming event
 *
 *   clean(file)                      validated copy, or throws (status 400)
 *   merge(file, sections, today)     items added or replaced by their key (KEYS), per section
 *   remove(file, section, match)     the items whose fields equal all of `match`
 *   brief(file, { today, last, fx }) what the read-out uses: insiders, politicians, analysts, contracts,
 *                                    holders, the CEO, the next results - each over a fixed window
 *   (no imports)
 */
const DAY = /^\d{4}-\d{2}-\d{2}$/, LINK = /^https?:\/\//;
const fail = m => Object.assign(new Error(m), { status: 400 });
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const num = (v, what) => (v === '' || v == null ? null : Number.isFinite(Number(v)) ? Number(v) : (() => { throw fail(`${what}: not a number (${v})`); })());

const KINDS = {
  contracts: ['award', 'framework', 'acquisition', 'divestment', 'investment', 'supply', 'other'],
  status: ['won', 'signed', 'pending', 'closed', 'completed', 'cancelled'],
  dealings: ['buy', 'sell', 'grant', 'exercise', 'other'],
  holders: ['fund', 'state', 'company', 'founder', 'employees', 'treasury', 'other'],
  ratings: ['buy', 'hold', 'sell'],
  events: ['results', 'guidance', 'deal', 'contract', 'rating', 'legal', 'management', 'capital', 'risk', 'macro', 'other'],
};
export const SECTIONS = ['contracts', 'people', 'dealings', 'holders', 'ratings', 'events'];
// what makes two items one: the same contract announced twice is one contract
export const KEYS = {
  contracts: ['date', 'customer', 'what'], people: ['name'], dealings: ['date', 'person', 'type', 'shares', 'price'],
  holders: ['name', 'date'], ratings: ['date', 'firm'], events: ['date', 'title'],
};
const keyOf = (section, x) => KEYS[section].map(k => String(x[k] ?? '').toLowerCase()).join('|');

function common(x, where, { date = true } = {}) {
  if (date && !DAY.test(x.date ?? '')) throw fail(`${where}: date YYYY-MM-DD`);
  if (x.source && !LINK.test(x.source)) throw fail(`${where}: source must be a link`);
  return { ...(x.note ? { note: str(x.note, 400) } : {}), source: str(x.source, 500) || null };
}
const oneOf = (v, list, where, fallback) => {
  const s = str(v, 20).toLowerCase() || fallback;
  if (!list.includes(s)) throw fail(`${where}: one of ${list.join(' ')}`);
  return s;
};
const cur = (v, where) => { const c = str(v, 3).toUpperCase() || 'EUR'; if (!/^[A-Z]{3}$/.test(c)) throw fail(`${where}: currency like EUR`); return c; };
const need = (v, max, where) => { const s = str(v, max); if (!s) throw fail(where); return s; };

const CLEAN = {
  contracts: (x, w) => ({
    date: x.date, customer: str(x.customer, 120) || null, what: need(x.what, 300, `${w}: what was it?`),
    value: num(x.value, `${w} value`), unit: x.value == null || x.value === '' ? null : oneOf(x.unit, ['m', 'bn'], `${w} unit`, 'm'),
    currency: cur(x.currency, w), ...(x.share ? { share: str(x.share, 120) } : {}),
    kind: oneOf(x.kind, KINDS.contracts, `${w} kind`, 'award'), delivery: str(x.delivery, 60) || null,
    status: oneOf(x.status, KINDS.status, `${w} status`, 'won'), segment: str(x.segment, 60) || null, ...common(x, w) }),
  people: (x, w) => ({
    name: need(x.name, 80, `${w}: name`), role: need(x.role, 80, `${w}: role`), since: str(x.since, 10) || null,
    background: str(x.background, 600) || null, pay: num(x.pay, `${w} pay`), payYear: str(x.payYear, 9) || null,
    payNote: str(x.payNote, 300) || null, shares: num(x.shares, `${w} shares`),
    sharesAt: x.sharesAt ? (DAY.test(x.sharesAt) ? x.sharesAt : (() => { throw fail(`${w}: sharesAt YYYY-MM-DD`); })()) : null,
    ...common(x, w, { date: false }) }),
  dealings: (x, w) => ({
    date: x.date, person: need(x.person, 100, `${w}: who?`), role: str(x.role, 120) || null, politician: !!x.politician,
    type: oneOf(x.type, KINDS.dealings, `${w} type`), shares: num(x.shares, `${w} shares`), price: num(x.price, `${w} price`),
    currency: cur(x.currency, w), ...(x.amount ? { amount: str(x.amount, 60) } : {}), plan: !!x.plan, ...common(x, w) }),
  holders: (x, w) => ({
    name: need(x.name, 120, `${w}: name`), pct: num(x.pct, `${w} pct`) ?? (() => { throw fail(`${w}: pct`); })(), date: x.date,
    kind: oneOf(x.kind, KINDS.holders, `${w} kind`, 'other'), ...common(x, w) }),
  ratings: (x, w) => ({
    date: x.date, firm: need(x.firm, 80, `${w}: firm`), rating: oneOf(x.rating, KINDS.ratings, `${w} rating`),
    ratingText: str(x.ratingText, 40) || null, target: num(x.target, `${w} target`), previousTarget: num(x.previousTarget, `${w} previousTarget`),
    currency: cur(x.currency, w), ...common(x, w) }),
  events: (x, w) => ({
    date: x.date, title: need(x.title, 200, `${w}: title`), kind: oneOf(x.kind, KINDS.events, `${w} kind`, 'other'), ...common(x, w) }),
};

export function clean(f) {
  const out = { company: str(f?.company, 80), isin: str(f?.isin, 12), updated: DAY.test(f?.updated ?? '') ? f.updated : null };
  for (const s of SECTIONS) {
    const seen = new Set();
    out[s] = (Array.isArray(f?.[s]) ? f[s] : []).map((x, i) => CLEAN[s](x ?? {}, `${s} ${i + 1}`))
      .filter(x => { const k = keyOf(s, x); return !seen.has(k) && seen.add(k); })
      .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || (b.pct ?? 0) - (a.pct ?? 0));
  }
  return out;
}

/** `sections`: { contracts: [...], ratings: [...] } - an item with the key of one already there replaces it. */
export function merge(file, sections = {}, today = null) {
  const out = structuredClone(file ?? {});
  for (const [s, items] of Object.entries(sections ?? {})) {
    if (!SECTIONS.includes(s)) throw fail(`no section "${s}": ${SECTIONS.join(', ')}`);
    if (!Array.isArray(items)) throw fail(`${s}: a list of items`);
    const list = Array.isArray(out[s]) ? out[s] : [];
    for (const x of items) {
      const c = CLEAN[s](x ?? {}, s), i = list.findIndex(y => keyOf(s, y) === keyOf(s, c));
      if (i < 0) list.push(c); else list[i] = c;
    }
    out[s] = list;
  }
  if (today) out.updated = today;
  return clean(out);
}

/** The items of a section whose fields equal every field of `match` (case-insensitive) - at least one field. */
export function remove(file, section, match = {}) {
  if (!SECTIONS.includes(section)) throw fail(`no section "${section}"`);
  const m = Object.entries(match ?? {}).filter(([, v]) => v != null && v !== '');
  if (!m.length) throw fail('say which: e.g. { "date": "2026-10-07", "firm": "Jefferies" }');
  const is = x => m.every(([k, v]) => String(x[k] ?? '').toLowerCase() === String(v).toLowerCase());
  const out = structuredClone(file), before = out[section].length;
  out[section] = out[section].filter(x => !is(x));
  return { file: out, removed: before - out[section].length };
}

// ------------------------------------------------------------ what the read-out uses
const daysBefore = (today, n) => new Date(Date.parse(today) - n * 864e5).toISOString().slice(0, 10);
const toEur = (v, c, fx) => (v == null ? null : c === 'EUR' ? v : fx?.[c] ? v / fx[c] : null);
const amountEur = (x, fx) => (x.value == null ? null : toEur(x.value * (x.unit === 'bn' ? 1e9 : 1e6), x.currency, fx));

/**
 * The company file over fixed windows, for the read-out:
 *   insiders     open-market trades of people who are not politicians, in the shape BaFin's and Nasdaq's take
 *                ({ m3, m12: { buys, sells, bought, sold }, recent }) - grants, exercises and plan trades left out
 *   politicians  politicians' trades of the last 12 months, buys and sells
 *   analysts     each firm's latest rating of the last 12 months: buy / hold / sell, targets in euros (ECB rate)
 *   contracts    announced in the last 12 months: how many, worth in euros (those with a value), the largest; pending deals
 *   holders      the latest stake per holder, largest first
 *   ceo          the person whose role says CEO / chief executive
 *   next         the first results event from today on
 */
export function brief(file, { today, fx = null } = {}) {
  if (!file || !today) return null;
  const m3 = daysBefore(today, 92), m12 = daysBefore(today, 366);
  const open = (file.dealings ?? []).filter(d => !d.politician && !d.plan && (d.type === 'buy' || d.type === 'sell'));
  const span = since => {
    const t = open.filter(d => d.date >= since && d.date <= today), sum = type => t.filter(d => d.type === type).reduce((s, d) => s + (d.shares ?? 0), 0);
    return { buys: t.filter(d => d.type === 'buy').length, sells: t.filter(d => d.type === 'sell').length, bought: sum('buy'), sold: sum('sell') };
  };
  const insiders = open.length ? { m3: span(m3), m12: span(m12), source: 'its company file',
    recent: open.slice(0, 10).map(d => ({ name: d.person, relation: d.role, date: d.date, type: d.type === 'buy' ? 'Buy' : 'Sell', shares: d.shares, price: d.price })),
    plans: (file.dealings ?? []).filter(d => !d.politician && (d.plan || !['buy', 'sell'].includes(d.type)) && d.date >= m12).length } : null;

  const politicians = (file.dealings ?? []).filter(d => d.politician && d.date >= m12 && d.date <= today);

  const latest = new Map();
  for (const r of (file.ratings ?? []).filter(x => x.date >= m12 && x.date <= today)) if (!latest.has(r.firm.toLowerCase())) latest.set(r.firm.toLowerCase(), r);   // newest first
  const rs = [...latest.values()], tg = rs.map(r => toEur(r.target, r.currency, fx)).filter(v => v > 0);
  const analysts = rs.length ? { n: rs.length, buy: rs.filter(r => r.rating === 'buy').length, hold: rs.filter(r => r.rating === 'hold').length,
    sell: rs.filter(r => r.rating === 'sell').length, targets: tg.length, target: tg.length ? tg.reduce((s, v) => s + v, 0) / tg.length : null,
    low: tg.length ? Math.min(...tg) : null, high: tg.length ? Math.max(...tg) : null, since: rs.at(-1).date, latest: rs[0] } : null;

  const won = (file.contracts ?? []).filter(c => c.date >= m12 && c.date <= today && c.status !== 'cancelled' && !['acquisition', 'divestment', 'investment'].includes(c.kind));
  const priced = won.map(c => ({ c, eur: amountEur(c, fx) })).filter(x => x.eur != null).sort((a, b) => b.eur - a.eur);
  const contracts = (file.contracts ?? []).length ? { n: won.length, priced: priced.length, eur: priced.reduce((s, x) => s + x.eur, 0),
    largest: priced.slice(0, 3).map(x => ({ ...x.c, eur: x.eur })),
    pending: (file.contracts ?? []).filter(c => c.status === 'pending').map(c => ({ ...c, eur: amountEur(c, fx) })), all: file.contracts.length } : null;

  const holders = [], seen = new Set();
  for (const h of file.holders ?? []) if (!seen.has(h.name.toLowerCase())) { seen.add(h.name.toLowerCase()); holders.push(h); }   // newest first
  holders.sort((a, b) => b.pct - a.pct);

  const ceo = (file.people ?? []).find(p => /\bCEO\b|chief executive/i.test(p.role)) ?? null;
  const next = (file.events ?? []).filter(e => e.kind === 'results' && e.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0] ?? null;
  return { updated: file.updated, insiders, politicians, analysts, contracts, holders, ceo, next };
}
