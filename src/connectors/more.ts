// Second wave of connectors (verified 2026-11-08):
//  • Lidl search API in 15 countries where Lidl sells FOOD online / in its online flyer
//  • Rimi (EE, LV, LT) – server-rendered cards with GTM product JSON
//  • Continente (PT) – SFCC tiles with impression JSON
//  • Prisma / S-kaupat (FI) – public GraphQL
//  • Konzum (HR) – server-rendered cards with GA attributes
//  • trolley.co.uk (UK) – price comparison: per-chain prices for Tesco, Sainsbury's, Asda, Morrisons...

import { fetchJson, HOUR, HttpError, sleep } from '../http.ts';
import { parseQuantity, unitPrice } from '../units.ts';
import { tokenize, tokenMatch } from '../text.ts';
import type { Offer, StoreConnector } from '../types.ts';

const SEARCH_CACHE = 6 * HOUR;
const UA = process.env.GROCERY_UA ?? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const cents = (v: number | string) => Math.round(Number(String(v).replace(',', '.')) * 100);
const decode = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#039;|&#39;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&pound;/g, '£').replace(/&euro;/g, '€').replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z])(acute|grave|circ|tilde|uml|cedil);/gi, (_, c, a) => (c + { acute: '́', grave: '̀', circ: '̂', tilde: '̃', uml: '̈', cedil: '̧' }[a as string]).normalize('NFC'));
const text = (html: string) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

const htmlCache = new Map<string, { at: number; v: string }>();
const inflight = new Map<string, Promise<string>>();
const hostSlots = new Map<string, { active: number; queue: Array<() => void> }>();

/** Max N concurrent requests per host: bursts get connections reset ("fetch failed"). */
async function withHostSlot<T>(host: string, max: number, fn: () => Promise<T>): Promise<T> {
  let s = hostSlots.get(host);
  if (!s) hostSlots.set(host, (s = { active: 0, queue: [] }));
  if (s.active >= max) await new Promise<void>((r) => s!.queue.push(r));
  s.active++;
  try {
    return await fn();
  } finally {
    s.active--;
    s.queue.shift()?.();
  }
}

async function fetchHtml(url: string, cacheMs = SEARCH_CACHE): Promise<string> {
  const hit = htmlCache.get(url);
  if (hit && Date.now() - hit.at < cacheMs) return hit.v;
  const pending = inflight.get(url); // several chains asking for the same trolley page at once
  if (pending) return pending;
  const p = (async () => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const v = await withHostSlot(new URL(url).host, 4, async () => {
          const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en;q=0.8' }, signal: AbortSignal.timeout(20000) });
          if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} for ${url}`), { status: res.status });
          return res.text();
        });
        if (htmlCache.size > 3000) htmlCache.delete(htmlCache.keys().next().value!);
        htmlCache.set(url, { at: Date.now(), v });
        return v;
      } catch (e: any) {
        lastErr = e;
        if (e?.status && e.status < 500 && e.status !== 429) break;
        await sleep(700 * (attempt + 1));
      }
    }
    throw lastErr;
  })();
  inflight.set(url, p);
  try {
    return await p;
  } finally {
    inflight.delete(url);
  }
}

function offer(o: Omit<Offer, 'unitPrice'>): Offer {
  return { ...o, unitPrice: unitPrice(o.price, o.pack) };
}

/** Serialize calls per host family with a small gap: some WAFs (Lidl) punish parallel bursts. */
function limiter(gapMs: number) {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {}).then(() => sleep(gapMs));
    return run;
  };
}

// ───────────────────────────── Lidl (15 countries) ─────────────────────────────
// Same "ldt-searcher" API everywhere. Countries where the online catalogue is non-food only
// (DE, FR, ES, PL, NL, BE, CZ, SK) are deliberately not registered.
const LIDL: Array<{ cc: string; tld: string; locale: string; currency: string; language: string }> = [
  { cc: 'IT', tld: 'it', locale: 'it_IT', currency: 'EUR', language: 'it' },
  { cc: 'PT', tld: 'pt', locale: 'pt_PT', currency: 'EUR', language: 'pt' },
  { cc: 'BG', tld: 'bg', locale: 'bg_BG', currency: 'EUR', language: 'bg' },
  { cc: 'RO', tld: 'ro', locale: 'ro_RO', currency: 'RON', language: 'ro' },
  { cc: 'CH', tld: 'ch', locale: 'de_CH', currency: 'CHF', language: 'de' },
  { cc: 'AT', tld: 'at', locale: 'de_AT', currency: 'EUR', language: 'de' },
  { cc: 'HU', tld: 'hu', locale: 'hu_HU', currency: 'HUF', language: 'hu' },
  { cc: 'SI', tld: 'si', locale: 'sl_SI', currency: 'EUR', language: 'sl' },
  { cc: 'RS', tld: 'rs', locale: 'sr_RS', currency: 'RSD', language: 'sr' },
  { cc: 'HR', tld: 'hr', locale: 'hr_HR', currency: 'EUR', language: 'hr' },
  { cc: 'LT', tld: 'lt', locale: 'lt_LT', currency: 'EUR', language: 'lt' },
  { cc: 'LV', tld: 'lv', locale: 'lv_LV', currency: 'EUR', language: 'lv' },
  { cc: 'EE', tld: 'ee', locale: 'et_EE', currency: 'EUR', language: 'et' },
  { cc: 'SE', tld: 'se', locale: 'sv_SE', currency: 'SEK', language: 'sv' },
  { cc: 'DK', tld: 'dk', locale: 'da_DK', currency: 'DKK', language: 'da' },
  { cc: 'FI', tld: 'fi', locale: 'fi_FI', currency: 'EUR', language: 'fi' },
  { cc: 'GB', tld: 'co.uk', locale: 'en_GB', currency: 'GBP', language: 'en' },
  { cc: 'IE', tld: 'ie', locale: 'en_IE', currency: 'EUR', language: 'en' },
];

export const lidlStores: StoreConnector[] = LIDL.map((c) => {
  const id = `lidl-${c.cc.toLowerCase()}`;
  const lidlLimiter = limiter(150); // per country
  return {
    info: {
      id, name: `Lidl ${c.cc}`, chain: 'Lidl', country: c.cc, currency: c.currency, language: c.language, cart: 'list', source: 'live',
      notes: 'Lidl online range + weekly offers (not the full shelf); buy in store.',
    },
    async search(query, _ctx, limit = 12) {
      const url = `https://www.lidl.${c.tld}/q/api/search?q=${encodeURIComponent(query)}&assortment=${c.cc}&locale=${c.locale}&version=v2.0.0&fetchsize=${Math.max(limit, 24)}`;
      // Lidl's WAF answers bursts with 401: back off and retry.
      let d: any;
      for (let attempt = 0; ; attempt++) {
        try {
          d = await lidlLimiter(() => fetchJson(url, { headers: { Accept: '*/*' }, cacheMs: SEARCH_CACHE }));
          break;
        } catch (e) {
          if (attempt >= 3 || !(e instanceof HttpError) || ![401, 403, 429].includes(e.status)) throw e;
          await sleep(1500 * (attempt + 1));
        }
      }
      const out: Offer[] = [];
      for (const it of d.items ?? []) {
        const g = it.gridbox?.data;
        const price = g?.price?.price;
        if (!g || price == null) continue;
        if (g.keyfacts?.analyticsCategory && g.keyfacts.analyticsCategory !== 'Food') continue;
        out.push(offer({
          storeId: id, productId: String(g.productId), name: g.fullTitle, brand: g.brand?.name, price: cents(price),
          regularPrice: g.price?.oldPrice ? cents(g.price.oldPrice) : undefined, currency: c.currency,
          pack: parseQuantity(g.price?.packaging?.text) ?? parseQuantity(g.fullTitle),
          url: g.canonicalUrl ? `https://www.lidl.${c.tld}${g.canonicalUrl}` : undefined, image: g.image, source: 'live',
        }));
      }
      return out;
    },
  };
});

// ───────────────────────────── Rimi (EE, LV, LT) ─────────────────────────────
const RIMI = [
  { cc: 'EE', host: 'www.rimi.ee', path: '/epood/ee/otsing', language: 'et' },
  { cc: 'LV', host: 'www.rimi.lv', path: '/e-veikals/lv/meklesana', language: 'lv' },
  { cc: 'LT', host: 'www.rimi.lt', path: '/e-parduotuve/lt/paieska', language: 'lt' },
];

export const rimiStores: StoreConnector[] = RIMI.map((c) => {
  const id = `rimi-${c.cc.toLowerCase()}`;
  return {
    info: { id, name: `Rimi ${c.cc}`, chain: 'Rimi', country: c.cc, currency: 'EUR', language: c.language, cart: 'deeplink', source: 'live', notes: 'Rimi e-shop (delivery & pickup).' },
    async search(query, _ctx, limit = 24) {
      const html = await fetchHtml(`https://${c.host}${c.path}?query=${encodeURIComponent(query)}`);
      const out: Offer[] = [];
      for (const card of html.split('data-product-code="').slice(1, limit + 1)) {
        const json = /data-gtm-eec-product='([^']+)'/.exec(card)?.[1];
        if (!json) continue;
        const p = JSON.parse(decode(json));
        const href = /class="card__url[^"]*" href="([^"]+)"/.exec(card)?.[1];
        const img = /data-src="([^"]+)"/.exec(card)?.[1];
        if (!(p.price > 0)) continue;
        out.push(offer({
          storeId: id, productId: String(p.id), name: p.name, brand: p.brand ?? undefined, price: cents(p.price), currency: p.currency ?? 'EUR',
          pack: parseQuantity(p.name), url: href ? `https://${c.host}${href}` : undefined, image: img, source: 'live',
        }));
      }
      return out;
    },
  };
});

// ───────────────────────────── Continente (PT) ─────────────────────────────
export const continente: StoreConnector = {
  info: { id: 'continente-pt', name: 'Continente', chain: 'Continente', country: 'PT', currency: 'EUR', language: 'pt', cart: 'deeplink', source: 'live', notes: 'Continente online (national price).' },
  async search(query, _ctx, limit = 24) {
    const html = await fetchHtml(`https://www.continente.pt/pesquisa/?q=${encodeURIComponent(query)}&start=0&sz=${limit}`);
    const out: Offer[] = [];
    for (const tile of html.split('data-product-tile-impression=').slice(1)) {
      const json = /^'([^']+)'/.exec(tile)?.[1] ?? /^"([^"]+)"/.exec(tile)?.[1];
      if (!json) continue;
      const p = JSON.parse(decode(json));
      const body = text(tile.slice(0, 6000).replace(/<svg[\s\S]*?<\/svg>/g, ''));
      const size = /emb\.\s*([^|€]+?)(?=\s+(?:Indispon|Dispon|\d+\s*,\d\d|$))/i.exec(body)?.[1] ?? /emb\.\s*([\d.,]+\s*(?:x\s*[\d.,]+\s*)?[a-z]+)/i.exec(body)?.[1];
      const url = /href="(https:\/\/www\.continente\.pt\/produto\/[^"]+)"/.exec(tile)?.[1];
      if (!(p.price > 0)) continue;
      out.push(offer({
        storeId: 'continente-pt', productId: String(p.id), name: p.name, brand: p.brand, price: cents(p.price), currency: 'EUR',
        pack: parseQuantity(size) ?? parseQuantity(p.name), url, source: 'live',
      }));
    }
    return out;
  },
};

// ───────────────────────────── Prisma / S-kaupat (FI) ─────────────────────────────
// S Group (Prisma, S-market, Alepa) – ~46 % of Finnish grocery. Store-specific prices.
export const prisma: StoreConnector = {
  info: { id: 'prisma-fi', name: 'Prisma (S-kaupat)', chain: 'S Group', country: 'FI', currency: 'EUR', language: 'fi', cart: 'deeplink', source: 'live', needs: ['branchId'], notes: 'S-kaupat GraphQL; default store Prisma Kannelmäki (Helsinki).' },
  async search(query, ctx, limit = 24) {
    const store = ctx.branchId ?? '513971200';
    const gql = `{ store(id: ${JSON.stringify(store)}) { products(queryString: ${JSON.stringify(query)}, limit: ${limit}) { items { id name price comparisonPrice comparisonUnit ean slug brandName priceUnit approxPrice } } } }`;
    const d = await fetchJson('https://api.s-kaupat.fi/', { body: { query: gql }, cacheMs: SEARCH_CACHE });
    return (d.data?.store?.products?.items ?? []).filter((p: any) => p.price > 0).map((p: any): Offer => {
      // Weighted items (priceUnit KGM): price is per kg.
      const pack = p.priceUnit === 'KGM' ? { amount: 1000, unit: 'g' as const } : parseQuantity(p.name);
      return offer({
        storeId: 'prisma-fi', productId: String(p.id), name: p.name, brand: p.brandName, price: cents(p.price), currency: 'EUR',
        pack, gtin: p.ean, url: `https://www.s-kaupat.fi/tuote/${p.slug}/${p.id}`, source: 'live',
      });
    });
  },
};

// ───────────────────────────── Konzum (HR) ─────────────────────────────
export const konzum: StoreConnector = {
  info: { id: 'konzum-hr', name: 'Konzum', chain: 'Konzum', country: 'HR', currency: 'EUR', language: 'hr', cart: 'deeplink', source: 'live', notes: 'Konzum Klik online shop.' },
  async search(query, _ctx, limit = 24) {
    const html = await fetchHtml(`https://www.konzum.hr/web/search?search%5Bterm%5D=${encodeURIComponent(query)}`);
    const out: Offer[] = [];
    for (const m of html.matchAll(/<article[^>]*class="[^"]*product-item[^"]*"[^>]*>([\s\S]*?)<\/article>/g)) {
      const a = m[1];
      const attr = (k: string) => decode(new RegExp(`data-ga-${k}="([^"]*)"`).exec(a)?.[1] ?? '');
      const name = attr('name');
      const price = attr('price').replace(/[^\d,.]/g, '');
      if (!name || !price) continue;
      const href = /href="(\/web\/products\/[^"]+)"/.exec(a)?.[1];
      out.push(offer({
        storeId: 'konzum-hr', productId: attr('id'), name, brand: attr('brand') || undefined, price: cents(price), currency: 'EUR',
        pack: parseQuantity(name), url: href ? `https://www.konzum.hr${href}` : undefined, source: 'live',
      }));
      if (out.length >= limit) break;
    }
    return out;
  },
};

// ───────────────────────────── trolley.co.uk (UK chains) ─────────────────────────────
// Tesco/Sainsbury's/Asda/Morrisons block bots; trolley.co.uk publishes their daily prices.
// Search -> pick candidates whose name matches the query -> product page "Where To Buy" table
// gives the price at each chain. Pages are cached and shared by all UK chain connectors.
interface TrolleyHit { id: string; path: string; name: string; size?: string }

async function trolleySearch(query: string): Promise<TrolleyHit[]> {
  const html = await fetchHtml(`https://www.trolley.co.uk/search/?q=${encodeURIComponent(query)}`);
  const hits: TrolleyHit[] = [];
  for (const m of html.matchAll(/<div class="product-item[^"]*" data-id="([^"]+)"[^>]*><a[^>]*href="([^"]+)" title="([^"]*)"/g)) {
    const title = decode(m[3]);
    const size = /\(([^()]*)\)\s*$/.exec(title)?.[1];
    hits.push({ id: m[1], path: m[2], name: title.replace(/\s*\([^()]*\)\s*$/, ''), size });
  }
  return hits;
}

async function trolleyPrices(hit: TrolleyHit): Promise<Record<string, number>> {
  const html = await fetchHtml(`https://www.trolley.co.uk${hit.path}`, 12 * HOUR);
  // 'comparison-table' also appears in inline CSS; anchor on the actual element.
  const start = html.indexOf('<div class="comparison-table');
  const table = start >= 0 ? html.slice(start, start + 40000) : '';
  const prices: Record<string, number> = {};
  for (const m of table.matchAll(/<svg title="([^"]+)" class="store-logo[\s\S]*?<div class="_price"><b>([^<]+)/g)) {
    const p = decode(m[2]).replace(/[^\d.]/g, '');
    if (p && !(m[1] in prices)) prices[m[1]] = cents(p);
  }
  return prices;
}

const UK_CHAINS = ['Tesco', "Sainsbury's", 'Asda', 'Morrisons', 'Waitrose', 'Iceland', 'Co-op']; // chains trolley.co.uk tracks

export const ukStores: StoreConnector[] = UK_CHAINS.map((chain) => {
  const id = `${chain.toLowerCase().replace(/[^a-z]/g, '')}-gb`;
  return {
    info: { id, name: chain, chain, country: 'GB', currency: 'GBP', language: 'en', cart: 'list', source: 'aggregator', notes: 'Daily prices via trolley.co.uk; cart via Pepesto.' },
    async search(query, _ctx, limit = 6) {
      const qt = tokenize(query);
      const hits = (await trolleySearch(query))
        // only open product pages that plausibly match (each page = 1 request)
        .filter((h) => { const nt = tokenize(h.name); return qt.every((t) => nt.some((n) => tokenMatch(n, t) !== 'none')); })
        .slice(0, Math.min(limit, 6));
      const out: Offer[] = [];
      await Promise.all(hits.map(async (h) => {
        const prices = await trolleyPrices(h).catch(() => ({} as Record<string, number>));
        const price = prices[chain];
        if (!price) return;
        out.push(offer({ storeId: id, productId: h.id, name: h.name, price, currency: 'GBP', pack: parseQuantity(h.size), url: `https://www.trolley.co.uk${h.path}`, source: 'aggregator' }));
      }));
      return out;
    },
  };
});


// ───────────────────────────── Kaufland (DE, CZ, SK) – weekly offers ─────────────────────────────
// The online shop is bot-protected, but the public offers overview (~750–1300 products/week) is not.
const KAUFLAND = [
  { cc: 'DE', url: 'https://filiale.kaufland.de/angebote/uebersicht.html', language: 'de' },
  { cc: 'CZ', url: 'https://prodejny.kaufland.cz/nabidka/prehled.html', language: 'cs' },
  { cc: 'SK', url: 'https://predajne.kaufland.sk/aktualna-ponuka/prehlad.html', language: 'sk' },
];

interface KRow { id: string; name: string; price: number; regular?: number; pack?: ReturnType<typeof parseQuantity> }
const kauflandCache = new Map<string, { at: number; rows: KRow[] }>();

async function kauflandOffers(url: string): Promise<KRow[]> {
  const hit = kauflandCache.get(url);
  if (hit && Date.now() - hit.at < SEARCH_CACHE) return hit.rows;
  const html = await fetchHtml(url);
  const field = (cls: string, x: string) => {
    const m = new RegExp(`class="${cls}[^"]*"[^>]*>([\\s\\S]*?)</(?:div|span|p|h\\d)>`).exec(x);
    return m ? text(m[1]) : '';
  };
  const rows: KRow[] = [];
  const seen = new Set<string>();
  for (const tile of html.split(/class="k-product-tile[ "]/).slice(1)) {
    const title = field('k-product-tile__title', tile);
    const price = field('k-price-tag__price', tile).replace(/[^\d.,]/g, '');
    if (!title || !price) continue;
    const name = [title, field('k-product-tile__subtitle', tile)].filter(Boolean).join(' ');
    if (seen.has(name)) continue;
    seen.add(name);
    // "je 5-kg-Sack", "je 0,5-l-Dose", "310 - 445-g-Packg." -> make the number/unit parseable
    const unitText = field('k-product-tile__unit-price', tile).replace(/(\d)-(kg|g|l|ml|cl)\b/gi, '$1 $2');
    const old = field('k-price-tag__old-price', tile).replace(/[^\d.,]/g, '');
    rows.push({ id: String(rows.length), name, price: cents(price), regular: old ? cents(old) : undefined, pack: parseQuantity(unitText) ?? parseQuantity(name) });
  }
  kauflandCache.set(url, { at: Date.now(), rows });
  return rows;
}

export const kauflandStores: StoreConnector[] = KAUFLAND.map((c) => {
  const id = `kaufland-${c.cc.toLowerCase()}`;
  const currency = c.cc === 'CZ' ? 'CZK' : 'EUR';
  return {
    info: { id, name: `Kaufland ${c.cc}`, chain: 'Kaufland', country: c.cc, currency, language: c.language, cart: 'list', source: 'live', notes: 'Kaufland weekly offers (not the full shelf); buy in store.' },
    async search(query, _ctx, limit = 16) {
      const qt = tokenize(query);
      return (await kauflandOffers(c.url))
        .filter((r) => { const nt = tokenize(r.name); return qt.every((t) => nt.some((n) => tokenMatch(n, t) !== 'none')); })
        .slice(0, limit)
        .map((r) => offer({ storeId: id, productId: r.id, name: r.name, price: r.price, regularPrice: r.regular, currency, pack: r.pack, url: c.url, source: 'live' }));
    },
  };
});

export const moreStores: StoreConnector[] = [...kauflandStores, ...lidlStores, ...rimiStores, continente, prisma, konzum, ...ukStores];
