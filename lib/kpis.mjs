/**
 * Company numbers: the figures a company reports in its own quarterly results that no free
 * feed carries - Shopee GMV, take rate, loan book, NPL for Sea; trips for Uber; and so on.
 * Data, so they live in data/kpis/<ISIN>.json (git-ignored, like everything in data/), filled
 * by hand in the Research tab or by an agent through the MCP. Each quarter names its source.
 * Your green / red lines: data/kpi-lines.json.
 *
 *   data/kpis/<ISIN>.json
 *     { company, isin, currency,
 *       metrics:  [{ id, label, unit: '$bn' | '$m' | 'bn' | 'm' | '%', help }],
 *       quarters: [{ period: '2026-Q2', reported: '2026-08-11', source: 'https://…', values: { id: number|null },
 *                    changes: { id: number } }] }      changes: the year-on-year change as the release states it
 *                                                       (optional) - releases round, so 11,1 / 6,9 says +61 % where
 *                                                       the company reports +62,5 %
 *
 *   clean(file)                         validated copy, or throws
 *   merge(file, { metrics, quarter })   metrics by id, a quarter by period
 *   table(file, lines, { today, nextResults })
 *        last 4 quarters per metric (cells) and every quarter (series) with the change on the same quarter a year before:
 *        amounts in % growth, rates (%) in points - as reported when the quarter has it. A line judges the growth of an amount and
 *        the level of a rate: { green, red } - green above red means higher is better.
 *        due: newer results are out (the next results date passed) or the last is 100+ days old
 *   point(t)                            the read-out line for the latest quarter
 */
const UNITS = ['$bn', '$m', 'bn', 'm', '%'];
const ID = /^[a-z][a-z0-9_]{0,39}$/, PERIOD = /^\d{4}-Q[1-4]$/, DAY = /^\d{4}-\d{2}-\d{2}$/;
const fail = m => Object.assign(new Error(m), { status: 400 });
const num = v => (v === '' || v == null ? null : Number.isFinite(Number(v)) ? Number(v) : (() => { throw fail(`not a number: ${v}`); })());
const str = (v, max) => String(v ?? '').trim().slice(0, max);

export function clean(f) {
  const metrics = (f.metrics || []).map(m => {
    if (!ID.test(m.id)) throw fail(`metric id "${m.id}": lowercase letters, digits, _`);
    if (!UNITS.includes(m.unit)) throw fail(`unit of ${m.id}: one of ${UNITS.join(' ')}`);
    if (!str(m.label, 60)) throw fail(`metric ${m.id} needs a label`);
    return { id: m.id, label: str(m.label, 60), unit: m.unit, help: str(m.help, 300) };
  });
  if (new Set(metrics.map(m => m.id)).size !== metrics.length) throw fail('two metrics with one id');
  const ids = new Set(metrics.map(m => m.id));
  const quarters = (f.quarters || []).map(q => {
    if (!PERIOD.test(q.period)) throw fail(`period "${q.period}": like 2026-Q2`);
    if (q.reported && !DAY.test(q.reported)) throw fail(`reported of ${q.period}: YYYY-MM-DD`);
    if (q.source && !/^https?:\/\//.test(q.source)) throw fail(`source of ${q.period}: a link`);
    const values = {}, changes = {};
    for (const [k, v] of Object.entries(q.values || {})) {
      if (!ids.has(k)) throw fail(`${q.period}: no metric "${k}"`);
      values[k] = num(v);
    }
    for (const [k, v] of Object.entries(q.changes || {})) {
      if (!ids.has(k)) throw fail(`${q.period}: no metric "${k}"`);
      if (num(v) != null) changes[k] = num(v);
    }
    return { period: q.period, reported: q.reported || null, source: str(q.source, 500) || null, values,
             ...(Object.keys(changes).length ? { changes } : {}) };
  }).sort((a, b) => a.period.localeCompare(b.period));
  if (new Set(quarters.map(q => q.period)).size !== quarters.length) throw fail('a quarter twice');
  return { company: str(f.company, 80), isin: str(f.isin, 12), currency: str(f.currency, 3) || 'USD', metrics, quarters };
}

export function merge(file, { metrics = [], quarter = null } = {}) {
  const out = structuredClone(file);
  for (const m of metrics) {
    const i = out.metrics.findIndex(x => x.id === m.id);
    if (i < 0) out.metrics.push(m); else out.metrics[i] = { ...out.metrics[i], ...m };
  }
  if (quarter) {
    const i = out.quarters.findIndex(q => q.period === quarter.period);
    if (i < 0) out.quarters.push(quarter);
    else out.quarters[i] = { ...out.quarters[i], ...quarter, values: { ...out.quarters[i].values, ...quarter.values },
                             changes: { ...out.quarters[i].changes, ...quarter.changes } };
  }
  return clean(out);
}

const yearBefore = p => `${Number(p.slice(0, 4)) - 1}${p.slice(4)}`;

/** A line is both numbers: green above red means higher is better (GMV growth), below means lower is (NPL). */
export function tone(x, line) {
  if (x == null || line?.green == null || line?.red == null) return null;
  const up = line.green >= line.red;
  if (up ? x >= line.green : x <= line.green) return 'good';
  if (up ? x <= line.red : x >= line.red) return 'bad';
  return 'neutral';
}

export function table(file, lines = {}, { today, nextResults } = {}) {
  if (!file?.quarters?.length) return file ? { ...file, last: [], rows: [], latest: null, due: false } : null;
  const qs = file.quarters, by = new Map(qs.map(q => [q.period, q]));
  const last = qs.slice(-4).map(q => q.period);
  const rows = file.metrics.map(m => {
    const rate = m.unit === '%';
    const cell = p => {
      const v = by.get(p)?.values[m.id] ?? null, b = by.get(yearBefore(p))?.values[m.id] ?? null;
      const told = by.get(p)?.changes?.[m.id];
      const change = told != null ? told : v == null || b == null ? null : rate ? v - b : b ? (v / Math.abs(b) - 1) * 100 : null;
      return { period: p, value: v, change, reported: told != null };
    };
    const series = qs.map(q => cell(q.period)), cells = series.slice(-4);
    const now = cells.at(-1), judged = rate ? now.value : now.change;
    return { ...m, measure: rate ? 'level' : 'growth', cells, series, judged, line: lines[m.id] ?? null, tone: tone(judged, lines[m.id]) };
  });
  const latest = qs.at(-1);
  const age = today && latest.reported ? (Date.parse(today) - Date.parse(latest.reported)) / 864e5 : 0;
  const due = !!(today && ((nextResults && nextResults <= today && (!latest.reported || nextResults > latest.reported)) || age > 100));
  return { company: file.company, isin: file.isin, currency: file.currency, last, rows,
           latest: { period: latest.period, reported: latest.reported, source: latest.source }, due };
}

// ------------------------------------------------------------ text
const nf = (min, max) => new Intl.NumberFormat('de-DE', { minimumFractionDigits: min, maximumFractionDigits: max });
export const fmt = (v, unit) => v == null ? '–'
  : unit === '%' ? `${nf(1, 1).format(v)} %`
  : `${nf(0, Math.abs(v) < 100 ? 1 : 0).format(v)}${unit.endsWith('bn') ? ' bn' : ' m'}${unit.startsWith('$') ? ' $' : ''}`;
export const fmtChange = (c, unit) => c == null ? '' : unit === '%'
  ? `${c > 0 ? '+' : c < 0 ? '−' : '±'}${nf(1, 1).format(Math.abs(c))} pts`
  : `${c > 0 ? '+' : c < 0 ? '−' : '±'}${nf(0, 1).format(Math.abs(c))} %`;

export function point(t) {
  if (!t?.rows?.length || !t.latest) return null;
  const toned = t.rows.filter(r => r.tone === 'good' || r.tone === 'bad');
  const good = toned.filter(r => r.tone === 'good').length, bad = toned.length - good;
  const q = t.latest.period.replace(/(\d{4})-(Q\d)/, '$2 $1');
  const parts = t.rows.filter(r => r.cells.at(-1).value != null)
    .map(r => `${r.label} ${fmt(r.cells.at(-1).value, r.unit)}${r.cells.at(-1).change != null ? ` (${fmtChange(r.cells.at(-1).change, r.unit)})` : ''}`);
  return { topic: 'Company numbers', group: 'business', tone: bad > good ? 'bad' : good > bad ? 'good' : 'neutral',
           head: toned.length ? `${good} of ${toned.length} lines met · ${q}` : q,
           text: `${q}: ${parts.join(', ')}.${t.due ? ' Newer results are out - update due.' : ''}`,
           rule: toned.length ? 'green / red: more of your lines met than missed, or the other way' : 'set your own green / red lines under Company numbers → Edit' };
}
