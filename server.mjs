#!/usr/bin/env node
/**
 * tr-overview - a Trade Republic depot overview from the transaction export.
 *
 *   node server.mjs        then open http://localhost:3000
 *
 * Runs on your machine only. Your exports, followed stocks and settings live in ./data
 * (DATA_DIR to move it), which git ignores. No database, no account, no dependencies.
 * Only public market data leaves the machine as requests: prices (onvista) and headlines
 * (Google News), by instrument name - never your transactions.
 *
 *   GET    /api/summary?joint=0|1&church=0|0.08|0.09   positions, months, tax per year
 *   POST   /api/upload       {files:[{name,text}]}      save Trade Republic exports into data/
 *   POST   /api/preview      {text, settings}           summary of one CSV, nothing saved (sample)
 *   GET    /api/news?lang=en|de                         headlines for holdings + followed stocks
 *   POST   /api/news         {subjects, lang}           headlines for given names (sample)
 *   GET    /api/watchlist                               followed stocks with today's move
 *   POST   /api/watchlist    {query}                    follow a name or an ISIN
 *   DELETE /api/watchlist/<key>
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { loadAll, mergeExports, parseExport, isTrExport, replay, holdings, positionsNow, months,
         taxYear, taxSettings, years } from './lib/portfolio.mjs';
import { quote, closes, search, pool } from './lib/market.mjs';
import { headlines } from './lib/news.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PUB  = path.join(HERE, 'public');
const DATA = path.resolve(process.env.DATA_DIR || path.join(HERE, 'data'));
const WATCH = path.join(DATA, 'watchlist.json');
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY = 20 * 1024 * 1024;

const berlinToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());
const titleCase = s => (s === s.toUpperCase() ? s.toLowerCase().replace(/\b\p{L}/gu, c => c.toUpperCase()) : s);
const rowKey = r => `${r.at}|${r.type}|${r.amount}|${r.key}|${r.shares}`;

const readWatch = () => { try { return JSON.parse(fs.readFileSync(WATCH, 'utf8')); } catch { return []; } };
const writeWatch = list => { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(WATCH, JSON.stringify(list, null, 2) + '\n'); };

const readJson = req => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', c => {
    size += c.length;
    if (size > MAX_BODY) { reject(new Error('upload too large')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
  req.on('error', reject);
});

async function quotesFor(keys) {
  const out = {};
  await pool(keys, 4, async k => {
    try { out[k] = await quote(k); } catch (e) { out[k] = { error: e.message }; }
  });
  return out;
}

async function summary(settings, merged = loadAll(DATA)) {
  const today = berlinToday();
  const { rows, files, first, last } = merged;
  if (!rows.length) return { empty: true, today };
  const st = replay(rows);
  const traded = [...new Set(rows.filter(r => r.type === 'BUY' || r.type === 'SELL').map(r => r.key))];
  const firstTrade = rows.find(r => r.type === 'BUY')?.date ?? first;
  const quotes = await quotesFor(holdings(st).map(h => h.key));
  const series = {}, errors = [];
  await pool(traded, 4, async k => {
    try { series[k] = await closes(k, firstTrade); }
    catch (e) { series[k] = []; errors.push(`${st.meta.get(k)?.name ?? k}: price history unavailable (${e.message})`); }
  });
  const pos = positionsNow(st, quotes);
  const tax = taxSettings(settings);
  const cur = Number(today.slice(0, 4));
  const ys = years(rows);
  if (!ys.includes(cur)) ys.push(cur);
  return {
    today, asOf: last, first, files, rowCount: rows.length, cash: st.cash, paidIn: st.paidIn, settings: tax,
    ...pos,
    months: months(rows, series, quotes, today),
    tax: Object.fromEntries(ys.map(y => [y, taxYear(rows, y, y === cur ? pos : null, today, tax)])),
    errors: errors.concat(pos.missing.map(n => `${n}: no live price`)),
  };
}

/** Exports are saved untouched; delete a file from data/ to undo an upload. */
function upload(files) {
  fs.mkdirSync(DATA, { recursive: true });
  const have = loadAll(DATA);
  const ids = new Set(have.rows.map(r => r.id)), alts = new Set(have.rows.map(rowKey));
  return files.map(f => {
    if (!isTrExport(f.text)) return { file: f.name, ok: false, reason: 'not a Trade Republic transaction export' };
    const rows = parseExport(f.text);
    if (!rows.length) return { file: f.name, ok: false, reason: 'no transactions in it' };
    const added = rows.filter(r => !ids.has(r.id) && !alts.has(rowKey(r))).length;
    if (!added) return { file: f.name, ok: true, rows: rows.length, added: 0, note: 'already have every row' };
    const dates = rows.map(r => r.date).sort();
    const span = `${dates[0]}_${dates.at(-1)}`;
    let name = `tr-${span}.csv`;
    for (let i = 2; fs.existsSync(path.join(DATA, name)); i++) name = `tr-${span}-${i}.csv`;
    fs.writeFileSync(path.join(DATA, name), f.text);
    rows.forEach(r => { ids.add(r.id); alts.add(rowKey(r)); });
    return { file: f.name, ok: true, rows: rows.length, added, savedAs: name };
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
    try { for (const h of await headlines(s.name, lang)) items.push({ ...h, key: s.key, name: s.name }); }
    catch (e) { errors.push(`${s.name}: ${e.message}`); }
  });
  items.sort((a, b) => b.at.localeCompare(a.at));
  return { subjects: unique, items, errors };
}

const TYPES = { html: 'text/html', css: 'text/css', js: 'text/javascript', svg: 'image/svg+xml',
                png: 'image/png', json: 'application/json', csv: 'text/csv', ico: 'image/x-icon' };

async function api(req, url) {
  const part = url.pathname.split('/').slice(2);              // ['summary'] | ['watchlist', key]
  const settings = { joint: url.searchParams.get('joint') === '1', church: Number(url.searchParams.get('church') || 0) };
  const lang = url.searchParams.get('lang') === 'de' ? 'de' : 'en';
  if (req.method === 'GET' && part[0] === 'summary') return [200, await summary(settings)];
  if (req.method === 'POST' && part[0] === 'upload') {
    const { files = [] } = await readJson(req);
    return [200, { files: upload(files.map(f => ({ name: String(f.name || 'export.csv'), text: String(f.text || '') }))) }];
  }
  if (req.method === 'POST' && part[0] === 'preview') {
    const { text = '', settings: s = {} } = await readJson(req);
    const m = mergeExports([{ name: 'preview.csv', text: String(text) }]);
    if (!m.rows.length) return [400, { error: m.files[0]?.reason || 'no transactions in it' }];
    return [200, { ...(await summary(s, { ...m, files: ['preview.csv'] })), preview: true }];
  }
  if (part[0] === 'news') {
    const body = req.method === 'POST' ? await readJson(req) : {};
    return [200, await news(body.lang === 'de' ? 'de' : body.lang ? 'en' : lang, body.subjects)];
  }
  if (part[0] === 'watchlist') {
    if (req.method === 'GET') {
      const list = readWatch(), q = await quotesFor(list.map(w => w.key));
      return [200, { items: list.map(w => ({ ...w, quote: q[w.key] })) }];
    }
    if (req.method === 'POST') {
      const text = String((await readJson(req)).query || '').trim();
      if (!text) return [400, { error: 'type a name or an ISIN' }];
      const hit = (await search(text))[0];
      if (!hit) return [404, { error: `nothing found for "${text}"` }];
      const list = readWatch();
      if (list.some(w => w.key === hit.key)) return [409, { error: `${titleCase(hit.name)} is already on the list` }];
      const item = { key: hit.key, name: titleCase(hit.name), isin: hit.isin, type: hit.type, added: berlinToday() };
      await quote(item.key);                                  // refuse a name that cannot be priced
      writeWatch([...list, item]);
      return [200, item];
    }
    if (req.method === 'DELETE' && part[1]) {
      const key = decodeURIComponent(part[1]);
      writeWatch(readWatch().filter(w => w.key !== key));
      return [200, { ok: true }];
    }
  }
  return [404, { error: 'not found' }];
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)); };
  try {
    if (url.pathname.startsWith('/api/')) {
      const [code, body] = await api(req, url);
      return json(code, body);
    }
    if (req.method === 'GET') {
      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const f = path.join(PUB, path.normalize(rel));
      if (f.startsWith(PUB + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile()) {
        res.writeHead(200, { 'content-type': `${TYPES[f.split('.').pop()] ?? 'application/octet-stream'}; charset=utf-8`,
                             'cache-control': 'no-cache' });
        return res.end(fs.readFileSync(f));
      }
    }
    json(404, { error: 'not found' });
  } catch (e) {
    json(500, { error: e.message });
  }
});

// localhost only: this serves your portfolio, it is not meant for the network
server.listen(PORT, '127.0.0.1', () => console.log(`tr-overview  http://localhost:${PORT}   data: ${DATA}`));
