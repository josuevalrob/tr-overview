// CSV helpers: an RFC4180 parser and a decimal-agnostic euro -> cents converter.

/** RFC4180 parser. Handles quoted fields, embedded delimiters, "" escapes, CRLF. */
export function parseCsv(text, delim = ';') {
  const rows = [];
  let row = [], field = '', inQuotes = false, i = 0;
  if (text.charCodeAt(0) === 0xfeff) i = 1; // strip BOM

  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { inQuotes = true; i++; continue; }
    if (c === delim)               { row.push(field); field = ''; i++; continue; }
    if (c === '\r')                { i++; continue; }
    if (c === '\n')                { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

/** Both "1.234,56" (de) and "1,234.56" (en): whichever separator is last is the decimal point. */
export function toCents(s) {
  s = String(s ?? '').trim();
  if (!s) return 0;
  const c = s.lastIndexOf(','), d = s.lastIndexOf('.');
  const norm = c > d ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  const n = Number.parseFloat(norm.replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
