/**
 * A company's own website, by its ISIN - an identifier lookup, no guessing by names.
 *
 *   website(isin, name)   'https://www.kws.com/' | null
 *   pickSite(sites, name) the one to show of several
 *
 * Source: Wikidata's "official website" (P856) of the item with that ISIN (P946), query.wikidata.org,
 * no key. A group can list its brands' and countries' sites too (Buzzi: 13, from alamocement.com to
 * dyckerhoff.com; Micron: micron.cn, tw.micron.com ...): a preferred one first, else the ones named like
 * the company (its first word, letters only): a generic domain (.com) before a country's, no subdomain
 * before one, then the shortest - buzzi.com, micron.com.
 * Wikidata can list only a company's old ISIN (Jenoptik: DE0006229107, not today's DE000A2NB601): with no item for
 * the ISIN, its legal entity identifier (LEI) from GLEIF's public register (api.gleif.org, no key, filter by ISIN)
 * finds the item by P1278 instead - still by identifier, not by name.
 * No item or no site: null - the caller may know one (Nasdaq for a US listing).
 * Cached in memory for a week.
 */
const UA = 'tr-overview/0.1 (https://github.com/josuevalrob/tr-overview)';   // Wikidata asks for one that says who
const WEEK = 7 * 24 * 60 * 60 * 1000;
const cache = new Map();

const host = u => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return ''; } };
const word = name => (String(name ?? '').toLowerCase().normalize('NFD').replace(/[^a-z0-9 ]/g, '').split(/\s+/).find(w => w.length >= 3) ?? '');

export function pickSite(sites, name) {
  if (!sites.length) return null;
  const best = sites.filter(s => s.preferred);
  if (best.length) return best[0].url;
  const w = word(name), named = w ? sites.filter(s => host(s.url).replace(/[^a-z0-9]/g, '').includes(w)) : [];
  const local = s => (/\.[a-z]{2}$/.test(host(s.url)) ? 1 : 0), labels = s => host(s.url).split('.').length;
  return (named.length ? named : sites).slice()
    .sort((a, b) => local(a) - local(b) || labels(a) - labels(b) || host(a.url).length - host(b.url).length)[0].url;
}

export async function website(isin, name) {
  if (!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin ?? '')) return null;
  const hit = cache.get(isin);
  if (hit && Date.now() - hit.at < WEEK) return hit.value;
  let sites = await sitesBy('P946', isin);
  if (!sites.length) {                                                    // an ISIN Wikidata does not know: by the LEI
    const lei = await leiOf(isin).catch(() => null);
    if (lei) sites = await sitesBy('P1278', lei);
  }
  const value = pickSite(sites, name);
  cache.set(isin, { at: Date.now(), value });
  return value;
}

/** The official websites of the Wikidata item with this identifier: P946 an ISIN, P1278 an LEI. */
async function sitesBy(prop, id) {
  const q = `SELECT ?site ?rank WHERE { ?item wdt:${prop} "${id}" . ?item p:P856 ?st . ?st ps:P856 ?site ; wikibase:rank ?rank . }`;
  const ask = () => fetch(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(q)}`,
                          { headers: { 'user-agent': UA, accept: 'application/sparql-results+json' }, signal: AbortSignal.timeout(15000) });
  let r = await ask().catch(() => null);
  if (!r?.ok) r = await ask();                                            // once more: Wikidata can be slow under load
  if (!r.ok) throw new Error(`Wikidata ${r.status}`);
  return ((await r.json()).results?.bindings ?? [])
    .filter(b => !b.rank?.value?.endsWith('DeprecatedRank'))
    .map(b => ({ url: b.site.value, preferred: b.rank?.value?.endsWith('PreferredRank') }));
}

/** The issuer's legal entity identifier by ISIN, from GLEIF's register - or null. */
async function leiOf(isin) {
  const r = await fetch(`https://api.gleif.org/api/v1/lei-records?filter%5Bisin%5D=${isin}`,
                        { headers: { 'user-agent': UA, accept: 'application/vnd.api+json' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) return null;
  const lei = (await r.json()).data?.[0]?.id;
  return /^[A-Z0-9]{20}$/.test(lei ?? '') ? lei : null;
}
