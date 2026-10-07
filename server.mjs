#!/usr/bin/env node
/**
 * tr-overview - a Trade Republic depot overview from the transaction export.
 *
 *   node server.mjs        then open http://localhost:3000
 *
 * Runs on your machine only. Your exports, followed stocks and settings live in ./data
 * (DATA_DIR to move it), which git ignores. No database, no account, no dependencies.
 * Only public market data leaves the machine as requests: prices (onvista) and headlines
 * (Google News), by instrument name - never your transactions. The logic is in lib/app.mjs,
 * shared with mcp.mjs (the same depot for agents).
 *
 *   GET    /api/summary?joint=0|1&church=0|0.08|0.09&live=1   positions, months, tax; live=1: prices under a minute old
 *   POST   /api/upload       {files:[{name,text}]}      save Trade Republic exports into data/
 *   POST   /api/preview      {text, settings}           summary of one CSV, nothing saved (sample)
 *   GET    /api/news?lang=en|de                         headlines for holdings + followed stocks
 *   POST   /api/news         {subjects, lang}           headlines for given names (sample)
 *   GET    /api/watchlist                               followed stocks with today's move
 *   POST   /api/watchlist    {query}                    follow a name or an ISIN
 *   DELETE /api/watchlist/<key>
 *   GET    /api/intraday                               today's recorded line (records a fresh point)
 *   GET    /api/analysis/<key>                         financials, analysts, events, dividends
 *   GET    /api/research/<key>?amount=5000             read-out, news, what buying that many € does to the depot
 *   GET    /api/kpis/<isin>                            company numbers (data/kpis/<isin>.json) with your lines
 *   PUT    /api/kpis/<isin>      {file}                replace them
 *   PUT    /api/kpi-lines/<isin> {lines}               your green / red lines (data/kpi-lines.json)
 *   GET    /api/search?q=SE                            name, ISIN or US ticker -> instruments
 *   GET    /api/history/<key>?from=YYYY-MM-DD          daily closes (EUR) for the price chart
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from './lib/app.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PUB  = path.join(HERE, 'public');
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY = 20 * 1024 * 1024;
const app  = createApp({ dataDir: process.env.DATA_DIR || path.join(HERE, 'data') });

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

const TYPES = { html: 'text/html', css: 'text/css', js: 'text/javascript', svg: 'image/svg+xml',
                png: 'image/png', json: 'application/json', csv: 'text/csv', ico: 'image/x-icon' };

async function api(req, url) {
  const part = url.pathname.split('/').slice(2);              // ['summary'] | ['watchlist', key]
  const settings = { joint: url.searchParams.get('joint') === '1', church: Number(url.searchParams.get('church') || 0) };
  if (req.method === 'GET' && part[0] === 'summary') return app.summary(settings, undefined, { maxAge: url.searchParams.get('live') === '1' ? 55 * 1000 : undefined });
  if (req.method === 'GET' && part[0] === 'intraday') return (await app.intraday(55 * 1000)) ?? {};
  if (req.method === 'POST' && part[0] === 'upload') {
    const { files = [] } = await readJson(req);
    return { files: app.upload(files.map(f => ({ name: String(f.name || 'export.csv'), text: String(f.text || '') }))) };
  }
  if (req.method === 'POST' && part[0] === 'preview') {
    const { text = '', settings: s = {} } = await readJson(req);
    return app.preview(text, s);
  }
  if (part[0] === 'news') {
    const body = req.method === 'POST' ? await readJson(req) : {};
    return app.news(body.lang ?? url.searchParams.get('lang'), body.subjects);
  }
  if (req.method === 'GET' && part[0] === 'analysis' && part[1]) return app.analysis(decodeURIComponent(part[1]));
  if (req.method === 'GET' && part[0] === 'research' && part[1]) return app.research(decodeURIComponent(part[1]), Number(url.searchParams.get('amount')) || 0);
  if (part[0] === 'kpis' && part[1]) {
    const key = decodeURIComponent(part[1]);
    if (req.method === 'GET') return app.kpis.get(key, url.searchParams.get('next') || undefined);
    if (req.method === 'PUT') return app.kpis.save(key, { file: (await readJson(req)).file });
  }
  if (req.method === 'PUT' && part[0] === 'kpi-lines' && part[1]) return app.kpis.lines(decodeURIComponent(part[1]), (await readJson(req)).lines);
  if (req.method === 'GET' && part[0] === 'search') return { results: (await app.search(url.searchParams.get('q') || '')).slice(0, 8) };
  if (req.method === 'GET' && part[0] === 'history' && part[1]) return app.history(decodeURIComponent(part[1]), url.searchParams.get('from'));
  if (part[0] === 'watchlist') {
    if (req.method === 'GET') return { items: await app.watchlist.list() };
    if (req.method === 'POST') return app.watchlist.add((await readJson(req)).query);
    if (req.method === 'DELETE' && part[1]) return app.watchlist.remove(decodeURIComponent(part[1]));
  }
  throw Object.assign(new Error('not found'), { status: 404 });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)); };
  try {
    if (url.pathname.startsWith('/api/')) return json(200, await api(req, url));
    // the page loads these two too (no imports): the "if you buy" slider and the company numbers' formats
    if (req.method === 'GET' && ['/lib/research.mjs', '/lib/kpis.mjs'].includes(url.pathname)) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(fs.readFileSync(path.join(HERE, url.pathname)));
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
    json(e.status || 500, { error: e.message });
  }
});

// localhost only: this serves your portfolio, it is not meant for the network
server.listen(PORT, '127.0.0.1', () => console.log(`tr-overview  http://localhost:${PORT}   data: ${app.dataDir}`));
app.intraday();
setInterval(() => app.intraday(), 5 * 60 * 1000);
