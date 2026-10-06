#!/usr/bin/env node
/**
 * Offline sanity checks on the model, against public/sample.csv. No network.
 *
 *   npm run check
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { mergeExports, replay, holdings, taxYear, taxSettings, months } from '../lib/portfolio.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const text = fs.readFileSync(path.join(HERE, '..', 'public', 'sample.csv'), 'utf8');
const lines = text.trim().split('\n');
let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`ok    ${name}`); }
  catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message}`); }
};

const all = mergeExports([{ name: 'sample.csv', text }]);

check('every sample row is read', () => assert.equal(all.rows.length, lines.length - 1));

check('overlapping exports never double-count', () => {
  const half = Math.floor(lines.length / 2);
  const a = [lines[0], ...lines.slice(1, half + 5)].join('\n');
  const b = [lines[0], ...lines.slice(half - 5)].join('\n');
  const m = mergeExports([{ name: 'a.csv', text: a }, { name: 'b.csv', text: b }]);
  assert.equal(m.rows.length, all.rows.length);
});

check('a file that is not an export is refused', () => {
  const m = mergeExports([{ name: 'x.csv', text: 'date;amount\n2026-01-01;5' }]);
  assert.equal(m.files[0].ok, false);
  assert.equal(m.rows.length, 0);
});

check('cash = amount + fee + tax, walked forward', () => {
  const st = replay(all.rows);
  const sum = all.rows.reduce((s, r) => s + r.amount + r.fee + r.tax, 0);
  assert.equal(st.cash, sum);
});

check('a sale is priced FIFO, order fees on both sides', () => {
  const st = replay(all.rows);
  const sale = st.sales.find(s => s.name === 'Apple');
  const buy = all.rows.find(r => r.type === 'BUY' && r.name === 'Apple');
  const expectCost = Math.round((-buy.amount - buy.fee) * sale.shares / buy.shares);
  assert.equal(sale.cost, expectCost);
  assert.equal(sale.gain, sale.proceeds - sale.cost);
});

check('the sold share leaves the position', () => {
  const st = replay(all.rows);
  const apple = holdings(st).find(h => h.name === 'Apple');
  const bought = all.rows.filter(r => r.type === 'BUY' && r.name === 'Apple').reduce((s, r) => s + r.shares, 0);
  assert.ok(Math.abs(apple.shares - (bought - 1)) < 1e-6);
});

check('tax rates: 26,375 % / 27,819 % / 27,995 %', () => {
  assert.equal(taxSettings().rate.toFixed(5), '0.26375');
  assert.equal(taxSettings({ church: 0.08 }).rate.toFixed(5), '0.27819');
  assert.equal(taxSettings({ church: 0.09 }).rate.toFixed(5), '0.27995');
  assert.equal(taxSettings({ joint: true }).allowance, 200000);
});

check('allowance: interest + dividends + stock gains, nothing over -> no tax', () => {
  const t = taxYear(all.rows, 2025, null, '2025-12-31');
  const interest = all.rows.filter(r => r.type === 'INTEREST_PAYMENT' && r.date.startsWith('2025')).reduce((s, r) => s + r.amount, 0);
  const divs = all.rows.filter(r => r.type === 'DIVIDEND' && r.date.startsWith('2025')).reduce((s, r) => s + r.amount, 0);
  assert.equal(t.capital, interest + divs);
  assert.equal(t.tax, 0);
});

check('over the allowance, the excess is taxed at the rate', () => {
  const t = taxYear(all.rows, 2025, null, '2025-12-31', { allowance: 1000, rate: 0.26375 });
  assert.equal(t.over, t.capital - 1000);
  assert.equal(t.tax, Math.round(t.over * 0.26375));
});

check('months: what a month earned excludes money paid in', () => {
  const ms = months(all.rows, {}, {}, '2026-09-30');
  for (let i = 1; i < ms.length; i++) {
    assert.equal(ms[i].result, ms[i].total - ms[i - 1].total - ms[i].paidIn);
  }
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
