/**
 * Headlines per company from Google News RSS. No key.
 *
 *   headlines(name, lang)   last 7 days, newest first -> { items, full }
 *                           full: Google's 100 for some day reached, so there is more than listed
 *   newsName(name)          "ASML (ADR)" -> "ASML": what a headline would actually say
 *   newsNames(name)         the company's names a headline might use: "Pinduoduo (PDD Holdings, Temu)" -> Pinduoduo, PDD Holdings
 *   stories(items)          same story from several outlets -> same .story id
 */
const TTL = 30 * 60 * 1000, PAST_TTL = 6 * 60 * 60 * 1000;   // today / days that are over
const UA  = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36';
const LANG = {
  en: 'hl=en-US&gl=US&ceid=US:en',
  de: 'hl=de&gl=DE&ceid=DE:de',
};

const cache = new Map();

export const newsName = n => n
  .replace(/\s*\([^)]*\)\s*/g, ' ')
  .replace(/\.com\b/i, '')
  .replace(/\b(Inc|Corp|Corporation|plc|AG|SE|N\.?V\.?|Holding|Group|Ltd)\b\.?/gi, '')
  .replace(/\s+/g, ' ').trim();

// onvista puts other names in brackets: "Pinduoduo (PDD Holdings, Temu)". Only company names count - a brand
// like Temu pulls in every shopping story; share classes ("ADR", "A") and former names ("ehem. ...") are not names
const COMPANY = /\b(Holdings?|Group|Inc|Corp|Corporation|Ltd|Limited|plc|AG|SE|N\.?V\.?|S\.?A\.?)\b/i;
export const newsNames = n => {
  const alias = [...n.matchAll(/\(([^)]*)\)/g)].flatMap(m => m[1].split(/[,;/]/)).map(x => x.trim())
    .filter(x => COMPANY.test(x) && !/^ehem\./i.test(x));
  return [...new Set([n, ...alias].map(newsName).filter(Boolean))];
};

const decode = s => s
  .replace(/^<!\[CDATA\[|\]\]>$/g, '')
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();

const tag = (xml, t) => { const m = xml.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return m ? decode(m[1]) : ''; };

// one Google News query, cached; Google lists at most 100 per query
async function feed(query, lang, ttl) {
  const id = `${lang}|${query}`;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < ttl) return hit.list;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&${LANG[lang] ?? LANG.en}`;
  const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Google News ${r.status}`);
  const xml = await r.text();
  const raw = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
  const items = raw.map(([, it]) => {
    const source = tag(it, 'source');
    let title = tag(it, 'title');
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    return { title, link: tag(it, 'link'), source, at: new Date(tag(it, 'pubDate')).toISOString() };
  }).filter(x => x.title && x.link);
  const list = { items, full: raw.length >= 100 };
  for (const [k, v] of cache) if (Date.now() - v.at > PAST_TTL) cache.delete(k);
  cache.set(id, { at: Date.now(), list });
  return list;
}

// One query per day: a whole week in one query stops at 100 and hides most of a busy stock.
// Today is "last 24 h" - Google's date filter has nothing for the current day yet.
export async function headlines(name, lang = 'en') {
  const q = newsNames(name).map(x => `"${x}"`).join(' OR '), iso = t => new Date(t).toISOString().slice(0, 10);
  const lists = [await feed(`${q} when:1d`, lang, TTL)];
  for (let k = 1; k <= 6; k++) {
    const d = iso(Date.now() - k * 864e5);
    lists.push(await feed(`${q} after:${d} before:${iso(Date.parse(d) + 864e5)}`, lang, PAST_TTL));
  }
  const seen = new Set();
  const items = lists.flatMap(l => l.items).filter(x => !seen.has(x.link) && seen.add(x.link))
    .sort((a, b) => b.at.localeCompare(a.at));
  return { items, full: lists.some(l => l.full) };
}

// ------------------------------------------------------------ stories
// Headlines about one stock that share their rare words within two days tell one story.
// Words are weighted by rarity across the whole list (tf-idf). Oldest first, a headline joins the story
// whose words it matches best (cosine to the story's summed words >= SAME), else it starts one; stories
// that grew apart in parallel are merged after. No model: the same list always groups the same way.
const SAME = 0.35, WINDOW = 48 * 36e5;
const STOP = new Set(`a an the and or but of to in on at for from by with as is are was were be been it its this that
  these those what why how who will would can could should has have had do does did not no than then so if into over
  under after before up down out about vs via says said say new just more most here you your we our they their he she
  his her him them us all any some only one two three stock stocks share shares inc corp plc ltd co company group
  holding holdings today week year der die das und oder mit von für auf aus bei ist sind wird wie was nach zum zur
  im am um den dem des ein eine einen einer aktie aktien`.split(/\s+/));
const words = s => s
  .replace(/\(?\b[A-Z]{2,6}:[A-Z.]{1,6}\)?|\b[A-Z]{2,5}\.[A-Z]{1,2}\b|\$[A-Z]{2,5}\b/g, ' ')   // (NASDAQ:MU), GAW.L, $META
  .toLowerCase()
  .replace(/[’']s\b/g, '')
  .replace(/\$?(\d+(?:[.,]\d+)*)\s*(b|bn|billion|mrd)\b/g, (_, d) => ` ${d.replace(/,/g, '')}b `)
  .replace(/\$?(\d+(?:[.,]\d+)*)\s*(m|mn|million|mio)\b/g, (_, d) => ` ${d.replace(/,/g, '')}m `)
  .replace(/(\d),(\d{3})/g, '$1$2')
  .replace(/[^\p{L}\p{N}.]+/gu, ' ').replace(/\.(?!\d)/g, ' ')
  .split(' ').filter(w => w && !STOP.has(w))
  .map(w => w.length > 4 ? w.replace(/ies$/, 'y').replace(/(?<!s)s$/, '') : w);

export function stories(items) {
  const toks = items.map(it => { const own = new Set(words(it.name)); return new Set(words(it.title).filter(w => !own.has(w))); });
  const df = new Map();
  for (const t of toks) for (const w of t) df.set(w, (df.get(w) || 0) + 1);
  const vec = toks.map(t => {
    const v = new Map([...t].map(w => [w, Math.log(items.length / df.get(w))]));
    return { v, len: Math.hypot(...v.values()) };
  });
  const cos = (a, b) => {
    if (!a.len || !b.len) return 0;
    let d = 0; for (const [w, x] of a.v) if (b.v.has(w)) d += x * b.v.get(w);
    return d / (a.len * b.len);
  };
  const add = (S, v) => { for (const [w, x] of v.v) S.v.set(w, (S.v.get(w) || 0) + x / (v.len || 1)); S.len = Math.hypot(...S.v.values()); };
  const at = items.map(it => Date.parse(it.at)), story = items.map((_, i) => i), byKey = new Map();
  items.forEach((it, i) => (byKey.get(it.key) || byKey.set(it.key, []).get(it.key)).push(i));
  for (const idx of byKey.values()) {
    idx.sort((a, b) => at[a] - at[b] || a - b);
    const open = [];                                    // { id, first, last, v, len, of: [i] }
    for (const i of idx) {
      let best = null, top = SAME;
      for (const S of open) {
        if (at[i] - S.last > WINDOW) continue;
        const c = cos(vec[i], S);
        if (c >= top) { top = c; best = S; }
      }
      if (!best) open.push(best = { id: i, first: at[i], last: at[i], v: new Map(), len: 0, of: [] });
      add(best, vec[i]); best.last = at[i]; best.of.push(i);
    }
    for (let merged = true; merged;) {
      merged = false;
      for (let a = 0; a < open.length; a++) for (let b = a + 1; b < open.length; b++) {
        const A = open[a], B = open[b];
        if (!A.of.length || !B.of.length || B.first - A.last > WINDOW || A.first - B.last > WINDOW || cos(A, B) < SAME) continue;
        for (const [w, x] of B.v) A.v.set(w, (A.v.get(w) || 0) + x);
        A.len = Math.hypot(...A.v.values());
        A.first = Math.min(A.first, B.first); A.last = Math.max(A.last, B.last);
        A.of.push(...B.of); B.of = []; merged = true;
      }
    }
    for (const S of open) for (const i of S.of) story[i] = S.id;
  }
  return items.map((it, i) => ({ ...it, story: story[i] }));
}
