/**
 * Everything tr-overview can do, over one data folder. Shared by server.mjs (the web page)
 * and mcp.mjs (agents), so both see the same depot.
 *
 *   const app = createApp({ dataDir })
 *   app.summary(settings, merged?, {maxAge})   positions, months, return per year, daily, tax, intraday
 *   app.preview(text, settings)  the same for one CSV, nothing saved
 *   app.upload(files)            save exports into the data folder
 *   app.news(lang, subjects?)    headlines for holdings + followed stocks, .story groups one story,
 *                                subject.full: Google's 100 reached, there is more
 *   app.watchlist.{list,add,remove}
 *   app.research(key, amount)    one stock: analysis, read-out, news, what buying `amount` € does to the depot
 *   app.kpis.{get,save,lines}    company numbers per ISIN: data/kpis/<ISIN>.json + your lines (data/kpi-lines.json)
 *   app.search(text)             name, ISIN or US ticker ("SE") -> instruments
 *   app.intraday(maxAge?)        record a point for today, return the day
 *   app.history(key, from)       daily closes + live quote
 *   app.analysis(key) · app.search(text) · app.rows()
 *
 * Errors meant for the user carry `.status` (400/404/409).
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadAll, mergeExports, parseExport, isTrExport, replay, holdings, positionsNow, months,
         taxYear, taxSettings, years, trades, daily, annualReturns } from './portfolio.mjs';
import { quote, closes, search, pool } from './market.mjs';
import { headlines, stories, newsName } from './news.mjs';
import { analysis, profile, tickerName } from './analysis.mjs';
import { readout, naming } from './research.mjs';
import * as K from './kpis.mjs';

export const berlinToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());
const titleCase = s => (s === s.toUpperCase() ? s.toLowerCase().replace(/\b\p{L}/gu, c => c.toUpperCase()) : s);
const rowKey = r => `${r.at}|${r.type}|${r.amount}|${r.key}|${r.shares}`;
const fail = (status, message) => Object.assign(new Error(message), { status });

/**
 * onvista searches names and ISINs; a US ticker typed in capitals ("SE", "UBER") finds the
 * wrong company there. So a ticker is first turned into its company name (Nasdaq), and the
 * US-listed line of that name wins.
 */
async function find(text) {
  const t = String(text || '').trim();
  if (/^[A-Z]{1,5}$/.test(t)) {
    const name = await tickerName(t);
    if (name) {
      const hits = (await search(name)).filter(h => h.type === 'STOCK');
      const best = hits.find(h => h.isin?.startsWith('US')) ?? hits[0];
      if (best) return [best, ...(await search(t)).filter(h => h.key !== best.key)];
    }
  }
  return search(t);
}

const berlinMinute = () => {
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hour12: false })
    .format(new Date()).split(':').map(Number);
  return h * 60 + m;
};

export async function quotesFor(keys, maxAge) {
  const out = {};
  await pool(keys, 4, async k => {
    try { out[k] = await quote(k, maxAge); } catch (e) { out[k] = { error: e.message }; }
  });
  return out;
}

export function createApp({ dataDir }) {
  const DATA = path.resolve(dataDir);
  const KPIS = path.join(DATA, 'kpis');
  const LINES = path.join(DATA, 'kpi-lines.json');
  const WATCH = path.join(DATA, 'watchlist.json');
  const INTRADAY = path.join(DATA, 'intraday.json');

  const readWatch = () => { try { return JSON.parse(fs.readFileSync(WATCH, 'utf8')); } catch { return []; } };
  const writeWatch = list => { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(WATCH, JSON.stringify(list, null, 2) + '\n'); };
  const readIntraday = () => { try { return JSON.parse(fs.readFileSync(INTRADAY, 'utf8')); } catch { return null; } };

  // ---------------------------------------------------------------- intraday
  // onvista does not serve intraday charts to scripts (403, terms of use), so the day's line
  // is recorded here: every minute while the page is open, every 5 minutes otherwise. One
  // file, started fresh each day. Your own data only, never the sample.

  /** Value and previous close of what is held now, from live quotes. */
  async function depotNow(rows, maxAge) {
    const hs = holdings(replay(rows));
    if (!hs.length) return null;
    const q = await quotesFor(hs.map(h => h.key), maxAge);
    let value = 0, prev = 0;
    for (const h of hs) {
      if (!q[h.key] || q[h.key].error) return null;      // a hole would draw a fake drop
      value += h.shares * q[h.key].last;
      prev += h.shares * (q[h.key].prev ?? q[h.key].last);
    }
    return { value: Math.round(value * 100), prev: Math.round(prev * 100) };
  }

  async function intraday(maxAge) {
    try {
      const now = await depotNow(loadAll(DATA).rows, maxAge);
      if (now) {
        const date = berlinToday(), m = berlinMinute();
        let day = readIntraday();
        if (day?.date !== date) day = { date, points: [] };
        day.prevClose = now.prev;
        const last = day.points.at(-1);
        if (last && m - last[0] < 1) last[1] = now.value;   // same minute: update, don't add
        else day.points.push([m, now.value]);
        fs.mkdirSync(DATA, { recursive: true });
        fs.writeFileSync(INTRADAY, JSON.stringify(day));
      }
    } catch { /* a missed sample is just a missing point */ }
    return readIntraday();
  }

  // ---------------------------------------------------------------- summary
  async function summary(settings, merged = loadAll(DATA), { maxAge } = {}) {
    const today = berlinToday();
    const { rows, files, first, last } = merged;
    if (!rows.length) return { empty: true, today };
    const st = replay(rows);
    const traded = [...new Set(rows.filter(r => r.type === 'BUY' || r.type === 'SELL').map(r => r.key))];
    const firstTrade = rows.find(r => r.type === 'BUY')?.date ?? first;
    const quotes = await quotesFor(holdings(st).map(h => h.key), maxAge);
    const series = {}, errors = [];
    await pool(traded, 4, async k => {
      try { series[k] = await closes(k, firstTrade); }
      catch (e) { series[k] = []; errors.push(`${st.meta.get(k)?.name ?? k}: price history unavailable (${e.message})`); }
    });
    const pos = positionsNow(st, quotes);
    const profiles = {};
    await pool(pos.positions.map(p => p.key), 4, async k => {
      try { profiles[k] = await profile(k); } catch { profiles[k] = { sector: 'Unknown', country: 'Unknown' }; }
    });
    const tax = taxSettings(settings);
    const cur = Number(today.slice(0, 4));
    const ys = years(rows);
    if (!ys.includes(cur)) ys.push(cur);
    const isPreview = files?.includes?.('preview.csv');
    return {
      today, asOf: last, first, files, rowCount: rows.length, cash: st.cash, paidIn: st.paidIn, settings: tax,
      ...pos,
      months: months(rows, series, quotes, today),
      annual: annualReturns(rows, today, st.cash + pos.value, pos.value),
      daily: daily(rows, series, quotes, today),
      trades: trades(rows),
      profiles,
      tax: Object.fromEntries(ys.map(y => [y, taxYear(rows, y, y === cur ? pos : null, today, tax)])),
      intraday: isPreview ? null : await intraday(maxAge),
      errors: errors.concat(pos.missing.map(n => `${n}: no live price`)),
    };
  }

  async function preview(text, settings) {
    const m = mergeExports([{ name: 'preview.csv', text: String(text) }]);
    if (!m.rows.length) throw fail(400, m.files[0]?.reason || 'no transactions in it');
    return { ...(await summary(settings, { ...m, files: ['preview.csv'] })), preview: true };
  }

  /**
   * Exports are saved untouched. An older export whose every row is in the new one is
   * replaced by it, so uploading a fresh "all time" export leaves one file, not a pile.
   * Delete a file from the data folder to undo an upload.
   */
  function upload(files) {
    fs.mkdirSync(DATA, { recursive: true });
    const has = (set, r) => (r.id && set.ids.has(r.id)) || set.alts.has(rowKey(r));
    const keysOf = rows => ({ ids: new Set(rows.map(r => r.id).filter(Boolean)), alts: new Set(rows.map(rowKey)) });
    return files.map(f => {
      if (!isTrExport(f.text)) return { file: f.name, ok: false, reason: 'not a Trade Republic transaction export' };
      const rows = parseExport(f.text);
      if (!rows.length) return { file: f.name, ok: false, reason: 'no transactions in it' };
      const existing = fs.readdirSync(DATA).filter(n => n.toLowerCase().endsWith('.csv')).map(n => {
        const text = fs.readFileSync(path.join(DATA, n), 'utf8');
        return { name: n, rows: isTrExport(text) ? parseExport(text) : null };
      }).filter(x => x.rows);
      const have = keysOf(existing.flatMap(x => x.rows)), mine = keysOf(rows);
      const added = rows.filter(r => !has(have, r)).length;
      const covered = existing.filter(x => x.rows.every(r => has(mine, r)));
      if (!added && covered.length < 2) return { file: f.name, ok: true, rows: rows.length, added: 0, note: 'already have every row' };
      const dates = rows.map(r => r.date).sort();
      const span = `${dates[0]}_${dates.at(-1)}`;
      let name = `tr-${span}.csv`;
      for (let i = 2; fs.existsSync(path.join(DATA, name)) && !covered.some(x => x.name === name); i++) name = `tr-${span}-${i}.csv`;
      fs.writeFileSync(path.join(DATA, name), f.text);
      const replaced = covered.map(x => x.name).filter(n => n !== name);
      for (const n of replaced) fs.unlinkSync(path.join(DATA, n));
      return { file: f.name, ok: true, rows: rows.length, added, savedAs: name, ...(replaced.length ? { replaced } : {}) };
    });
  }

  async function news(lang, given) {
    const subjects = given
      ? given.filter(s => s && s.key && s.name).map(s => ({ key: String(s.key), name: String(s.name), held: !!s.held }))
      : holdings(replay(loadAll(DATA).rows)).map(h => ({ key: h.key, name: h.name, held: true }))
          .concat(readWatch().map(w => ({ key: w.key, name: w.name, held: false })));
    const seen = new Set(), unique = subjects.filter(s => !seen.has(s.key) && seen.add(s.key)).slice(0, 40);
    const items = [], errors = [];
    await pool(unique, 4, async s => {
      try {
        const h = await headlines(s.name, lang === 'de' ? 'de' : 'en');
        for (const x of h.items) items.push({ ...x, key: s.key, name: s.name });
        if (h.full) s.full = true;
      }
      catch (e) { errors.push(`${s.name}: ${e.message}`); }
    });
    items.sort((a, b) => b.at.localeCompare(a.at));
    return { subjects: unique, items: stories(items), errors };
  }

  const watchlist = {
    async list() {
      const list = readWatch(), q = await quotesFor(list.map(w => w.key));
      return list.map(w => ({ ...w, quote: q[w.key] }));
    },
    async add(query) {
      const text = String(query || '').trim();
      if (!text) throw fail(400, 'type a name or an ISIN');
      const hit = (await find(text))[0];
      if (!hit) throw fail(404, `nothing found for "${text}"`);
      const list = readWatch();
      if (list.some(w => w.key === hit.key)) throw fail(409, `${titleCase(hit.name)} is already on the list`);
      const item = { key: hit.key, name: titleCase(hit.name), isin: hit.isin, type: hit.type, added: berlinToday() };
      await quote(item.key);                                // refuse a name that cannot be priced
      writeWatch([...list, item]);
      return item;
    },
    remove(key) {
      const list = readWatch();
      writeWatch(list.filter(w => w.key !== key));
      return { removed: list.length - readWatch().length };
    },
  };

  async function history(key, from) {
    from = /^\d{4}-\d{2}-\d{2}$/.test(from || '') ? from : new Date(Date.now() - 5 * 365 * 864e5).toISOString().slice(0, 10);
    const series = (await closes(key, from)).filter(([d]) => d >= from);
    let live = null;
    try { live = await quote(key); } catch { /* history alone is fine */ }
    return { key, from, closes: series, live };
  }

  // ---------------------------------------------------------------- company numbers
  const isin = key => { if (!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(key)) throw fail(400, 'company numbers are kept per ISIN'); return key; };
  const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  const kpis = {
    file: key => readJson(path.join(KPIS, `${isin(key)}.json`), null),
    async get(key, nextResults) {
      const file = kpis.file(key), lines = readJson(LINES, {})[key] ?? {};
      return { file, lines, table: K.table(file, lines, { today: berlinToday(), nextResults }) };
    },
    /** { file } replaces it; { metrics, quarter } merge into it. A new file takes the name from onvista. */
    async save(key, { file, metrics, quarter }) {
      let base = kpis.file(key);
      if (!base) {
        const an = await analysis(key);
        base = { company: titleCase(an.name).replace(/\s*\(ADR\)/, ''), isin: key, currency: key.startsWith('US') ? 'USD' : 'EUR', metrics: [], quarters: [] };
      }
      const out = file ? K.clean({ ...base, ...file, isin: key }) : K.merge(base, { metrics, quarter });
      fs.mkdirSync(KPIS, { recursive: true });
      fs.writeFileSync(path.join(KPIS, `${key}.json`), JSON.stringify(out, null, 2) + '\n');
      return kpis.get(key);
    },
    /** { metricId: { green, red } }; a metric without both numbers has no line */
    lines(key, lines) {
      const all = readJson(LINES, {}), mine = {};
      for (const [id, l] of Object.entries(lines || {})) {
        const g = l?.green === '' || l?.green == null ? null : Number(l.green), r = l?.red === '' || l?.red == null ? null : Number(l.red);
        if (Number.isFinite(g) && Number.isFinite(r)) mine[id] = { green: g, red: r };
      }
      all[isin(key)] = mine;
      fs.mkdirSync(DATA, { recursive: true });
      fs.writeFileSync(LINES, JSON.stringify(all, null, 2) + '\n');
      return kpis.get(key);
    },
  };

  /**
   * Everything about one stock for deciding on it: the analysis, a year and a half of prices,
   * this week's news, and the read-out made from them (lib/research.mjs). With `amount` (euros)
   * it also says what that buy would do to the depot's weights and country mix.
   */
  async function research(key, amount = 0) {
    const today = berlinToday();
    const from = new Date(Date.parse(today) - 400 * 864e5).toISOString().slice(0, 10);
    const an = await analysis(key);
    const [h, n, d] = await Promise.all([
      history(key, from).catch(() => null),
      news('en', [{ key, name: titleCase(an.name) }]).catch(e => ({ items: [], errors: [e.message] })),
      summary({}).catch(() => null),
    ]);
    const depot = d && !d.empty ? { cash: d.cash, positions: d.positions.map(p => ({ key: p.key, name: p.name, value: p.value,
                                                                                     country: d.profiles?.[p.key]?.country,
                                                                                     sector: d.profiles?.[p.key]?.sector })) } : null;
    const held = d && !d.empty ? d.positions.find(p => p.key === key) ?? null : null;
    const names = [newsName(titleCase(an.name)).split(' ')[0], an.profile?.symbol];
    const r = readout({ an, closes: h?.closes ?? [], quote: h?.live, news: n.items, depot, amount: Number(amount) || 0, today, names });
    const k = an.isin ? await kpis.get(key, an.us?.earningsDate) : null;
    const kp = K.point(k?.table);
    if (kp) { const at = r.points.findIndex(p => p.topic === 'Next results' || p.topic === 'News'); r.points.splice(at < 0 ? r.points.length : at, 0, kp); }
    return { key, name: titleCase(an.name), isin: an.isin, type: an.type, profile: an.profile, quote: h?.live ?? null,
             held: held && { shares: held.shares, value: held.value, gain: held.gain, gainPct: held.gainPct, weight: held.weight },
             depot, kpis: k?.table ?? null, ...r, news: n.items.map(i => ({ ...i, about: naming(names)(i.title) })), errors: n.errors ?? [], notes: an.notes, following: readWatch().some(w => w.key === key) };
  }

  return {
    dataDir: DATA,
    rows: () => loadAll(DATA).rows,
    watchRaw: readWatch,
    summary, preview, upload, news, watchlist, intraday, history, analysis, research, kpis,
    search: async text => (await find(text)).map(h => ({ ...h, name: titleCase(h.name) })),
  };
}
