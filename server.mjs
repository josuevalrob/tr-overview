#!/usr/bin/env node
/**
 * tr-overview - a Trade Republic depot overview from the transaction export.
 *
 *   node server.mjs        then open http://localhost:3000
 *
 * Stateless: no database, nothing written to disk. The browser keeps the uploaded CSV
 * and sends it with every request; the server computes, fetches prices and headlines,
 * answers, and forgets. Only public market data is cached, in memory.
 *
 *   POST /api/summary   {files:[{name,text}], settings:{joint,church}}  positions, months, tax
 *   POST /api/news      {subjects:[{key,name}], lang:'en'|'de'}          headlines
 *   POST /api/quotes    {keys:[...]}                                      last + previous close
 *   GET  /api/search?q=name-or-ISIN                                       instrument lookup
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { mergeExports, replay, holdings, positionsNow, months, taxYear, taxSettings, years } from './lib/portfolio.mjs';
import { quote, closes, search, pool } from './lib/market.mjs';
import { headlines } from './lib/news.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PUB  = path.join(HERE, 'public');
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY = 20 * 1024 * 1024;

const berlinToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());
const titleCase = s => (s === s.toUpperCase() ? s.toLowerCase().replace(/\b\p{L}/gu, c => c.toUpperCase()) : s);

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

async function summary({ files = [], settings = {} }) {
  const today = berlinToday();
  const merged = mergeExports(files.map(f => ({ name: String(f.name || 'export.csv'), text: String(f.text || '') })));
  const { rows, first, last } = merged;
  if (!rows.length) return { empty: true, today, files: merged.files };
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
    today, asOf: last, first, files: merged.files, rowCount: rows.length,
    cash: st.cash, paidIn: st.paidIn, settings: tax,
    ...pos,
    months: months(rows, series, quotes, today),
    tax: Object.fromEntries(ys.map(y => [y, taxYear(rows, y, y === cur ? pos : null, today, tax)])),
    errors: errors.concat(pos.missing.map(n => `${n}: no live price`)),
  };
}

async function news({ subjects = [], lang = 'en' }) {
  const seen = new Set();
  const unique = subjects.filter(s => s && s.key && s.name && !seen.has(s.key) && seen.add(s.key)).slice(0, 40);
  const items = [], errors = [];
  await pool(unique, 4, async s => {
    try { for (const h of await headlines(String(s.name), lang === 'de' ? 'de' : 'en')) items.push({ ...h, key: s.key, name: s.name }); }
    catch (e) { errors.push(`${s.name}: ${e.message}`); }
  });
  items.sort((a, b) => b.at.localeCompare(a.at));
  return { items, errors };
}

const TYPES = { html: 'text/html', css: 'text/css', js: 'text/javascript', svg: 'image/svg+xml',
                png: 'image/png', json: 'application/json', csv: 'text/csv', ico: 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)); };
  try {
    if (req.method === 'POST' && url.pathname === '/api/summary') return json(200, await summary(await readJson(req)));
    if (req.method === 'POST' && url.pathname === '/api/news') return json(200, await news(await readJson(req)));
    if (req.method === 'POST' && url.pathname === '/api/quotes') {
      const { keys = [] } = await readJson(req);
      return json(200, await quotesFor([...new Set(keys.map(String))].slice(0, 60)));
    }
    if (req.method === 'GET' && url.pathname === '/api/search') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return json(400, { error: 'type a name or an ISIN' });
      const hit = (await search(q))[0];
      if (!hit) return json(404, { error: `nothing found for "${q}"` });
      await quote(hit.key);                                   // refuse a name that cannot be priced
      return json(200, { key: hit.key, name: titleCase(hit.name), isin: hit.isin, type: hit.type });
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

server.listen(PORT, () => console.log(`tr-overview  http://localhost:${PORT}`));
