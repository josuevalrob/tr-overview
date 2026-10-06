/**
 * Headlines per company from Google News RSS. No key.
 *
 *   headlines(name, lang)   last 7 days, newest first, cached 30 min per query
 *   newsName(name)          "ASML (ADR)" -> "ASML": what a headline would actually say
 */
const TTL = 30 * 60 * 1000;
const UA  = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36';
const LANG = {
  en: 'hl=en-US&gl=US&ceid=US:en',
  de: 'hl=de&gl=DE&ceid=DE:de',
};

const cache = new Map();

export const newsName = n => n
  .replace(/\s*\((ADR|A|B|C|ehem\.[^)]*)\)\s*/gi, ' ')
  .replace(/\.com\b/i, '')
  .replace(/\b(Inc|Corp|Corporation|plc|AG|SE|N\.?V\.?|Holding|Group|Ltd)\b\.?/gi, '')
  .replace(/\s+/g, ' ').trim();

const decode = s => s
  .replace(/^<!\[CDATA\[|\]\]>$/g, '')
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();

const tag = (xml, t) => { const m = xml.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return m ? decode(m[1]) : ''; };

export async function headlines(name, lang = 'en') {
  const q = newsName(name);
  const id = `${lang}|${q}`;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL) return hit.items;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`"${q}" when:7d`)}&${LANG[lang] ?? LANG.en}`;
  const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Google News ${r.status}`);
  const xml = await r.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, it]) => {
    const source = tag(it, 'source');
    let title = tag(it, 'title');
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    return { title, link: tag(it, 'link'), source, at: new Date(tag(it, 'pubDate')).toISOString() };
  }).filter(x => x.title && x.link)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 15);
  cache.set(id, { at: Date.now(), items });
  return items;
}
