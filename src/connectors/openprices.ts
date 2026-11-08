// Open Food Facts "Open Prices" (ODbL): crowd-sourced shelf prices from receipts & price tags.
// The only free source for chains whose web shops are bot-protected or price-hidden:
// E.Leclerc, Carrefour, Auchan, Intermarché, Super U, Monoprix, Franprix (FR), Extra, Kiwi,
// Rema 1000 (NO), Willys (SE), EDEKA (DE)... Prices are ESTIMATES with an observation date
// (`observedAt`), latest observation per product per chain since 2024.
// Dumps: https://prices.openfoodfacts.org/data/{prices,locations,products}.jsonl.gz (daily).

import { createReadStream } from 'node:fs';
import { mkdir, rename, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { HOUR } from '../http.ts';
import { lookup, termsFor } from '../ingredients.ts';
import { parseQuantity, q as mkq, unitPrice } from '../units.ts';
import { tokenize, tokenMatch } from '../text.ts';
import type { Offer, Quantity, StoreConnector } from '../types.ts';

const CACHE_DIR = process.env.GROCERY_CACHE_DIR ?? join(import.meta.dirname, '..', '..', '.cache');
const BASE = 'https://prices.openfoodfacts.org/data';
const SINCE = '2024-01-01';

/** Chain groups: OSM brand regex + country -> store. */
const CHAINS: Array<{ id: string; name: string; country: string; currency: string; language: string; re: RegExp }> = [
  { id: 'leclerc-fr', name: 'E.Leclerc', country: 'FR', currency: 'EUR', language: 'fr', re: /leclerc/i },
  { id: 'carrefour-fr', name: 'Carrefour', country: 'FR', currency: 'EUR', language: 'fr', re: /carrefour/i },
  { id: 'auchan-fr', name: 'Auchan', country: 'FR', currency: 'EUR', language: 'fr', re: /auchan/i },
  { id: 'intermarche-fr', name: 'Intermarché', country: 'FR', currency: 'EUR', language: 'fr', re: /intermarch/i },
  { id: 'superu-fr', name: 'Super U', country: 'FR', currency: 'EUR', language: 'fr', re: /^(super u|hyper u|u express|marché u|utile)\b/i },
  { id: 'monoprix-fr', name: 'Monoprix', country: 'FR', currency: 'EUR', language: 'fr', re: /monoprix/i },
  { id: 'franprix-fr', name: 'Franprix', country: 'FR', currency: 'EUR', language: 'fr', re: /franprix/i },
  { id: 'lidl-fr', name: 'Lidl FR', country: 'FR', currency: 'EUR', language: 'fr', re: /^lidl/i },
  { id: 'aldi-fr', name: 'Aldi FR', country: 'FR', currency: 'EUR', language: 'fr', re: /^aldi/i },
  { id: 'extra-no', name: 'Extra', country: 'NO', currency: 'NOK', language: 'no', re: /^(coop )?extra/i },
  { id: 'kiwi-no', name: 'Kiwi', country: 'NO', currency: 'NOK', language: 'no', re: /^kiwi/i },
  { id: 'rema1000-no', name: 'Rema 1000', country: 'NO', currency: 'NOK', language: 'no', re: /rema 1000/i },
  { id: 'willys-se', name: 'Willys', country: 'SE', currency: 'SEK', language: 'sv', re: /willys/i },
  { id: 'edeka-de', name: 'EDEKA', country: 'DE', currency: 'EUR', language: 'de', re: /edeka/i },
];

async function download(name: string): Promise<string> {
  await mkdir(CACHE_DIR, { recursive: true });
  const file = join(CACHE_DIR, `openprices-${name}.jsonl.gz`);
  try {
    if (Date.now() - (await stat(file)).mtimeMs < 24 * HOUR) return file;
  } catch {}
  try {
    const res = await fetch(`${BASE}/${name}.jsonl.gz`, { signal: AbortSignal.timeout(30 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body as any), createWriteStream(file + '.part'));
    await rename(file + '.part', file);
  } catch (e) {
    try {
      await stat(file); // keep serving yesterday's dump
    } catch {
      throw e;
    }
  }
  return file;
}

async function* lines(file: string) {
  const rl = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const l of rl) if (l) yield JSON.parse(l);
}

interface Row { id: string; name: string; price: number; pack?: Quantity; date: string; url?: string }

const CATEGORY_NAMES: Record<string, string> = {}; // "en:carrots" -> "carrots"
function categoryName(tag: string) {
  return CATEGORY_NAMES[tag] ??= tag.replace(/^[a-z]{2}:/, '').replace(/-/g, ' ');
}

let loading: Promise<Map<string, Row[]>> | undefined;
let loadedAt = 0;

function load(): Promise<Map<string, Row[]>> {
  if (loading && Date.now() - loadedAt < 24 * HOUR) return loading;
  loadedAt = Date.now();
  loading = (async () => {
    const [pricesF, locationsF, productsF] = await Promise.all([download('prices'), download('locations'), download('products')]);
    const chainOfLocation = new Map<string, string>();
    for await (const l of lines(locationsF)) {
      const brand = String(l.osm_brand ?? l.osm_name ?? '');
      const cc = String(l.osm_address_country_code ?? '').toUpperCase();
      const chain = CHAINS.find((c) => c.re.test(brand) && (!cc || cc === c.country));
      if (chain) chainOfLocation.set(String(l.id), chain.id);
    }
    // latest price per (chain, product)
    const latest = new Map<string, any>();
    const codes = new Set<string>();
    for await (const p of lines(pricesF)) {
      const chain = chainOfLocation.get(String(p.location_id));
      if (!chain || !p.date || p.date < SINCE || p.duplicate_of) continue;
      const key = `${chain}|${p.product_code ?? p.category_tag ?? p.product_name}`;
      const prev = latest.get(key);
      if (!prev || p.date > prev.date) latest.set(key, p);
      if (p.product_code) codes.add(String(p.product_code));
    }
    const products = new Map<string, any>();
    for await (const pr of lines(productsF)) if (codes.has(String(pr.code))) products.set(String(pr.code), pr);

    const byChain = new Map<string, Row[]>();
    for (const [key, p] of latest) {
      const chain = key.split('|')[0];
      const prod = p.product_code ? products.get(String(p.product_code)) : undefined;
      // Loose produce is recorded as an English category ("en:lemons"): give it the store-language
      // name ("citrons", "sitron") so the matcher's localized terms find it.
      let name = prod?.product_name || p.product_name || '';
      if (!name && p.category_tag) {
        const cat = categoryName(p.category_tag);
        const key = lookup(cat)?.key;
        const lang = CHAINS.find((c) => c.id === chain)?.language ?? 'en';
        name = key ? `${termsFor(key, lang)[0]} (${cat})` : cat;
      }
      const price = Math.round(Number(p.price) * 100);
      if (!name || !(price > 0)) continue;
      let pack: Quantity | undefined;
      if (p.price_per === 'KILOGRAM') pack = { amount: 1000, unit: 'g' };
      else if (p.price_per === 'UNIT') pack = { amount: 1, unit: 'pcs' };
      else if (prod?.product_quantity) {
        try {
          pack = mkq(Number(prod.product_quantity), String(prod.product_quantity_unit || 'g'));
        } catch {}
      }
      pack ??= parseQuantity(prod?.quantity);
      const brand = prod?.brands ? ` ${String(prod.brands).split(',')[0]}` : '';
      (byChain.get(chain) ?? byChain.set(chain, []).get(chain)!).push({
        id: String(p.product_code ?? p.category_tag ?? p.id), name: `${name}${brand}`.trim(), price, pack, date: p.date,
        url: p.product_code ? `https://prices.openfoodfacts.org/products/${p.product_code}` : undefined,
      });
    }
    return byChain;
  })().catch((e) => {
    loading = undefined;
    throw e;
  });
  return loading;
}

export const openPricesStores: StoreConnector[] = CHAINS.map((c) => ({
  info: {
    id: c.id, name: c.name, chain: c.name, country: c.country, currency: c.currency, language: c.language, cart: 'list', source: 'crowd',
    notes: 'Open Prices (crowd-sourced receipts, ODbL): estimated price with observation date.',
  },
  async search(query, _ctx, limit = 16) {
    const rows = (await load()).get(c.id) ?? [];
    const qt = tokenize(query);
    return rows
      .filter((r) => { const nt = tokenize(r.name); return qt.every((t) => nt.some((n) => tokenMatch(n, t) !== 'none')); })
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, limit)
      .map((r): Offer => ({
        storeId: c.id, productId: r.id, name: r.name, price: r.price, currency: c.currency, pack: r.pack,
        unitPrice: unitPrice(r.price, r.pack), url: r.url, source: 'crowd', observedAt: r.date,
      }));
  },
}));

/** Start the (slow, ~40 MB) download at boot. */
export function warmOpenPrices() {
  return load().then(() => undefined);
}
