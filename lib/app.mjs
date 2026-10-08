/**
 * Everything tr-overview can do, over one data folder. Shared by server.mjs (the web page)
 * and mcp.mjs (agents), so both see the same depot.
 *
 *   const app = createApp({ dataDir })
 *   app.summary(settings, merged?, {maxAge})   positions, months, return per year, daily, tax, intraday
 *   app.preview(text, settings)  the same for one CSV, nothing saved
 *   app.upload(files)            save exports into the data folder
 *   app.news(lang, subjects?)    headlines that name a holding or followed stock, .story groups one story,
 *                                subject.full: Google's 100 reached, there is more
 *   app.watchlist.{list,add,remove}
 *   app.favorites.{list,add,remove}
 *   app.research(key, amount)    one stock: analysis, read-out, news, what buying `amount` € does to the depot
 *   app.kpis.{get,save,lines}    company numbers per ISIN: data/kpis/<ISIN>.json + your lines (data/kpi-lines.json)
 *   app.analysis(key)            lib/analysis.mjs, with the analysts' quarter estimates kept in data/estimates/<ISIN>.json
 *   app.search(text)             name, ISIN or US ticker ("SE") -> instruments, with their US listing and the exact match
 *   app.intraday(maxAge?)        record a point for today, return the day
 *   app.history(key, from)       daily closes + live quote
 *   app.search(text) · app.rows()
 *
 * Errors meant for the user carry `.status` (400/404/409).
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadAll, mergeExports, parseExport, isTrExport, replay, holdings, positionsNow, months,
         taxYear, taxSettings, years, trades, daily, annualReturns, homeCurrency, currencySplit, currencyToday } from './portfolio.mjs';
import { quote, closes, search, pool, fxNow } from './market.mjs';
import { headlines, stories, headlineNames, newsName, newsNames, otherNames, localNews } from './news.mjs';
import { analysis, profile, tickerName } from './analysis.mjs';
import { website } from './website.mjs';
import { usListings } from './figi.mjs';
import { readout, naming, score } from './research.mjs';
import * as K from './kpis.mjs';
import { rates, fxHistory } from './rates.mjs';

export const berlinToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());
const titleCase = s => (s === s.toUpperCase() ? s.toLowerCase().replace(/\b\p{L}/gu, c => c.toUpperCase()) : s);
const rowKey = r => `${r.at}|${r.type}|${r.amount}|${r.key}|${r.shares}`;
const fail = (status, message) => Object.assign(new Error(message), { status });

/**
 * Name, ISIN or US ticker -> instruments, best first. Shares carry where they trade in the US
 * (`us`: ticker + exchange, by ISIN from OpenFIGI). `exact`: the ISIN, or the US ticker, that was typed.
 *
 * onvista searches names and ISINs only, so a word that could be a ticker ("onon", "SE") is also
 * turned into its company's name (Nasdaq) and that is searched too; which hit IS that ticker is then
 * told by the ID - its ISIN's US ticker - not by how alike the names look.
 * Order: a line named exactly as typed ("sap": SAP before SAP (ADR)), the ticker or ISIN typed,
 * then onvista's hits for the text, then those for the ticker's company.
 */
const ISIN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;
async function find(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  const isin = ISIN.test(t.toUpperCase()) ? t.toUpperCase() : null;
  const ticker = !isin && /^[a-z]{1,5}([.-][a-z])?$/i.test(t) ? t.toUpperCase() : null;
  const company = ticker ? await tickerName(ticker) : null;
  const [own, theirs] = await Promise.all([byName(isin ?? t), company ? byName(company) : []]);
  const seen = new Set(), hits = [...own, ...theirs].filter(h => !seen.has(h.key) && seen.add(h.key));
  const shares = [...own.slice(0, 8), ...theirs.slice(0, 8)].filter(h => h.type === 'STOCK' && h.isin).map(h => h.isin);
  const us = await usListings(shares).catch(() => ({}));
  const bare = bareName(t).toLowerCase(), first = new Set(own.map(h => h.key));
  const rank = h => h.name.toLowerCase() === bare ? 0 : h.exact ? 1 : first.has(h.key) ? 2 : 3;
  return hits.map(h => ({ ...h, us: us[h.isin] ?? null, exact: isin ? h.isin === isin : !!ticker && us[h.isin]?.ticker === ticker }))
    .map((h, i) => ({ h, i })).sort((a, b) => rank(a.h) - rank(b.h) || a.i - b.i).map(x => x.h);
}

/**
 * onvista finds nothing or another line for a name with its legal form ("Airbus SE", "Apple Inc":
 * Pineapple, "SAP SE": a CDR), so the name without it is searched first. A line named exactly
 * so comes first: "Siemens" before Siemens Energy.
 */
const LEGAL = /(?:[,&\s]+(?:AG|SE|N\.?V|S\.?A|A\/S|ASA|AB|plc|Inc|Corp|Corporation|Ltd|Co|KGaA|GmbH)\.?)+$/i;
const bareName = text => text.replace(LEGAL, '').trim() || text;
async function byName(text) {
  const bare = bareName(text);
  const hits = bare !== text ? [...await search(bare), ...await search(text)] : await search(text);
  const seen = new Set(), unique = hits.filter(h => !seen.has(h.key) && seen.add(h.key));
  const exact = h => h.name.toLowerCase() === bare.toLowerCase();             // not "Airbus (ADR)" for Airbus
  return [...unique.filter(exact), ...unique.filter(h => !exact(h))];
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
  const ESTIMATES = path.join(DATA, 'estimates');
  const WATCH = path.join(DATA, 'watchlist.json');
  const FAVS = path.join(DATA, 'favorites.json');
  const INTRADAY = path.join(DATA, 'intraday.json');

  const readWatch = () => { try { return JSON.parse(fs.readFileSync(WATCH, 'utf8')); } catch { return []; } };
  const writeWatch = list => { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(WATCH, JSON.stringify(list, null, 2) + '\n'); };
  const readFavs = () => { try { return JSON.parse(fs.readFileSync(FAVS, 'utf8')); } catch { return []; } };
  const writeFavs = keys => { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(FAVS, JSON.stringify(keys, null, 2) + '\n'); };
  const heldKeys = () => { try { return new Set(holdings(replay(loadAll(DATA).rows)).map(h => h.key)); } catch { return new Set(); } };
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
    // the price or the currency: ECB rates from a week before the first buy (a Saturday buy takes Friday's)
    const fxFrom = new Date(Date.parse(firstTrade) - 7 * 864e5).toISOString().slice(0, 10);
    const profiles = {};
    await pool(pos.positions.map(p => p.key), 4, async k => {
      try { profiles[k] = await profile(k); } catch { profiles[k] = { sector: 'Unknown', country: 'Unknown' }; }
    });
    const home = k => profiles[k]?.currency ?? homeCurrency(k);           // its main listing's currency
    pos.positions = currencySplit(pos.positions, await fxHistory(pos.positions.map(p => home(p.key)), fxFrom), home);
    pos.positions = currencyToday(pos.positions, await fxNow(pos.positions.map(p => home(p.key)), maxAge), home);
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

  // other companies of the same family, by onvista's search for the name, and their US tickers - asked once a week
  const kin = new Map();
  async function others(name) {
    const hit = kin.get(name);
    if (hit && Date.now() - hit.at < 7 * 864e5) return hit;
    const hits = (await Promise.all(newsNames(name).map(n => search(n).catch(() => [])))).flat();
    const names = otherNames(name, hits);
    const isins = hits.filter(h => h.isin && names.includes(newsName(h.name))).map(h => h.isin);
    const us = isins.length ? await usListings(isins).catch(() => ({})) : {};
    const out = { at: Date.now(), names, tickers: [...new Set(Object.values(us).filter(Boolean).map(l => l.ticker))] };
    kin.set(name, out);
    return out;
  }

  async function news(lang, given) {
    const subjects = given
      ? given.filter(s => s && s.key && s.name).map(s => ({ key: String(s.key), name: String(s.name), held: !!s.held }))
      : holdings(replay(loadAll(DATA).rows)).map(h => ({ key: h.key, name: h.name, held: true }))
          .concat(readWatch().map(w => ({ key: w.key, name: w.name, held: false })));
    const seen = new Set(), unique = subjects.filter(s => !seen.has(s.key) && seen.add(s.key)).slice(0, 40);
    const us = await usListings(unique.map(s => s.key).filter(k => ISIN.test(k))).catch(() => ({}));
    const items = [], errors = [];
    // Google matches the words anywhere in the article: only headlines that name the company or its ticker
    // stay - "case on holding energy companies liable" is not about On Holding, "Brookfield Renewable ..." not about Brookfield
    await pool(unique, 4, async s => {
      try {
        const h = await headlines(s.name, lang === 'de' ? 'de' : 'en', us[s.key]);
        // "Brookfield (BAM) Upgraded to Buy" names a sister company's ticker and not its own: about the sister
        const family = await others(s.name), own = us[s.key]?.ticker;
        const named = naming(headlineNames(s.name, [own]), family.names);
        const theirs = family.tickers.length ? naming(family.tickers.filter(t => t !== own)) : () => false, ours = own ? naming([own]) : () => false;
        const about = x => named(x.title) && !(theirs(x.title) && !ours(x.title)) && !(localNews(x) && !ours(x.title));
        for (const x of h.items) if (about(x)) items.push({ ...x, key: s.key, name: s.name });
        if (h.full) s.full = true;
      }
      catch (e) { errors.push(`${s.name}: ${e.message}`); }
    });
    items.sort((a, b) => b.at.localeCompare(a.at));
    return { subjects: unique, items: stories(items), errors };
  }

  const watchlist = {
    async list() {
      const list = readWatch(), q = await quotesFor(list.map(w => w.key)), prof = {};
      await pool(list.map(w => w.key), 4, async k => {            // sector and country, for grouping on Research
        try { prof[k] = await profile(k); } catch { prof[k] = { sector: 'Unknown', country: 'Unknown' }; }
      });
      return list.map(w => ({ ...w, quote: q[w.key], ...prof[w.key], home: prof[w.key]?.currency ?? homeCurrency(w.key) }));
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
      if (!heldKeys().has(key)) writeFavs(readFavs().filter(k => k !== key));   // no chip left to carry the star
      return { removed: list.length - readWatch().length };
    },
  };

  // Favorites: a star on a stock in your list, held or followed (data/favorites.json, its keys).
  // Starring one that is neither follows it, so it has a chip on Research.
  const favorites = {
    list: readFavs,
    async add(key) {
      key = String(key || '').trim();
      if (!key) throw fail(400, 'which stock?');
      const followed = heldKeys().has(key) || readWatch().some(w => w.key === key) ? null : await watchlist.add(key);
      const k = followed?.key ?? key, list = readFavs();
      if (!list.includes(k)) writeFavs([...list, k]);
      return { key: k, followed };
    },
    remove(key) {
      const list = readFavs();
      writeFavs(list.filter(k => k !== key));
      return { removed: list.length - readFavs().length };
    },
  };

  async function history(key, from) {
    from = /^\d{4}-\d{2}-\d{2}$/.test(from || '') ? from : new Date(Date.now() - 5 * 365 * 864e5).toISOString().slice(0, 10);
    const series = (await closes(key, from)).filter(([d]) => d >= from);
    let live = null;
    try { live = await quote(key); } catch { /* history alone is fine */ }
    return { key, from, closes: series, live };
  }

  // ---------------------------------------------------------------- analysts' quarter estimates
  /**
   * The analysis, with the analysts' estimate for each quarter kept in data/estimates/<ISIN>.json until its
   * results are out: Yahoo drops an estimate then, and keeps only the EPS one - so revenue against its estimate
   * needs it saved before. Each reported quarter gets the revenue estimate kept for it (`revenueEstimate`).
   */
  async function analyzed(key) {
    const an = await analysis(key), E = an.estimates;
    // its own website: Wikidata by ISIN, else the one Nasdaq lists (an ADR's ISIN is often not on Wikidata). Asked
    // here, not in the day-long analysis cache: website.mjs keeps answers a week, a failed lookup is asked again next time
    if (an.profile) an.profile.website = (await website(key, an.name).catch(() => undefined)) ?? an.us?.website ?? null;
    if (!E || !an.isin) return an;
    const file = path.join(ESTIMATES, `${an.isin}.json`), kept = readJson(file, { quarters: {} }), today = berlinToday();
    const out = new Set(E.reported.map(q => q.end));
    let changed = false;
    for (const q of E.quarters.filter(x => !out.has(x.end))) {
      const v = { currency: E.currency, eps: q.eps, epsAnalysts: q.epsAnalysts, revenue: q.revenue, revenueAnalysts: q.revenueAnalysts, seen: today };
      if (JSON.stringify(kept.quarters[q.end]) !== JSON.stringify(v)) { kept.quarters[q.end] = v; changed = true; }
    }
    if (changed) {
      fs.mkdirSync(ESTIMATES, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(kept, null, 2) + '\n');
    }
    E.reported = E.reported.map(q => {
      const k = kept.quarters[q.end];
      return { ...q, revenueEstimate: k?.currency === E.currency ? k.revenue ?? null : null };
    });
    return an;
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
        const an = await analyzed(key);
        // amounts in dollars ($m, $bn) are a company reporting in USD, wherever it is listed (Brookfield)
        const usd = key.startsWith('US') || (metrics ?? []).some(m => m.unit?.startsWith('$'));
        base = { company: titleCase(an.name).replace(/\s*\(ADR\)/, ''), isin: key, currency: usd ? 'USD' : 'EUR', metrics: [], quarters: [] };
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
   * Everything about one stock for deciding on it: the analysis, ten years of prices,
   * this week's news, and the read-out made from them (lib/research.mjs). With `amount` (euros)
   * it also says what that buy would do to the depot's weights and country mix.
   */
  async function research(key, amount = 0) {
    const today = berlinToday();
    const from = new Date(Date.parse(today) - 10 * 366 * 864e5).toISOString().slice(0, 10);   // ten years, for P/E over time
    const an = await analyzed(key);
    const [h, n, d, fx] = await Promise.all([
      history(key, from).catch(() => null),
      news('en', [{ key, name: titleCase(an.name) }]).catch(e => ({ items: [], errors: [e.message] })),
      summary({}).catch(() => null),
      rates(),
    ]);
    const depot = d && !d.empty ? { cash: d.cash, positions: d.positions.map(p => ({ key: p.key, name: p.name, value: p.value,
                                                                                     country: d.profiles?.[p.key]?.country,
                                                                                     sector: d.profiles?.[p.key]?.sector, home: p.home })) } : null;
    const held = d && !d.empty ? d.positions.find(p => p.key === key) ?? null : null;
    const names = headlineNames(titleCase(an.name), [an.profile?.symbol, an.us?.listedAs ?? an.us?.ticker]);
    const k = an.isin ? await kpis.get(key, an.us?.earningsDate ?? an.estimates?.next?.date) : null;
    const own = K.ownMeasure(k?.file, { shares: an.profile?.shares, fx: fx?.fx });
    const r = readout({ an, closes: h?.closes ?? [], quote: h?.live, news: n.items, depot, amount: Number(amount) || 0, today, names, rates: fx, own });
    const kp = K.point(k?.table);
    if (kp) { const at = r.points.findIndex(p => p.topic === 'Next results' || p.topic === 'News'); r.points.splice(at < 0 ? r.points.length : at, 0, kp); }
    r.score = score(r.points, r.groups);                       // after the company numbers: they can speak for it too
    return { key, name: titleCase(an.name), isin: an.isin, type: an.type, profile: an.profile, fund: an.fund ?? null, quote: h?.live ?? null,
             held: held && { shares: held.shares, value: held.value, gain: held.gain, gainPct: held.gainPct, weight: held.weight },
             depot, kpis: k?.table ?? null, ...r, news: n.items.map(i => ({ ...i, about: naming(names)(i.title) })), errors: n.errors ?? [], notes: an.notes, following: readWatch().some(w => w.key === key),
             favorite: readFavs().includes(key) };
  }

  return {
    dataDir: DATA,
    rows: () => loadAll(DATA).rows,
    watchRaw: readWatch,
    summary, preview, upload, news, watchlist, favorites, intraday, history, analysis: analyzed, research, kpis,
    search: async text => (await find(text)).map(h => ({ ...h, name: titleCase(h.name) })),
  };
}
