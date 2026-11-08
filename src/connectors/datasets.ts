// Dataset connectors: whole-catalogue daily dumps published by open-source price trackers.
// Zero per-request cost and no anti-bot exposure; we download once a day and search in memory.
//
//  • checkjebon.nl  – 12 Dutch chains (AH, Jumbo, Lidl NL, Plus, Dirk, Hoogvliet, Spar, DekaMarkt,
//                     Poiesz, Vomar, Aldi*, Ekoplaza*) – rebuilt daily, ~10 MB.
//  • heisse-preise.io – Austria (BILLA is maintained; others flagged stale) – per-store compressed files.

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HOUR } from '../http.ts';
import { parseQuantity, q as mkq, unitPrice } from '../units.ts';
import type { Offer, Quantity, StoreConnector, StoreInfo } from '../types.ts';
import { tokenize, tokenMatch } from '../text.ts';

const CACHE_DIR = process.env.GROCERY_CACHE_DIR ?? join(import.meta.dirname, '..', '..', '.cache');
const DAY = 24 * HOUR;

interface Row {
  id: string;
  name: string;
  price: number; // minor units
  pack?: Quantity;
  url?: string;
}

/** Inverted index over product names for fast token search. */
class Catalogue {
  rows: Row[];
  index = new Map<string, number[]>();
  constructor(rows: Row[]) {
    this.rows = rows;
    rows.forEach((r, i) => {
      for (const t of new Set(tokenize(r.name))) {
        let list = this.index.get(t);
        if (!list) this.index.set(t, (list = []));
        list.push(i);
      }
    });
  }
  search(query: string, limit: number): Row[] {
    const toks = tokenize(query);
    if (!toks.length) return [];
    // Candidate rows must contain every query token as a prefix of some name token
    // ("tomaten" also hits "cherrytomaten" via the compound check below).
    const scores = new Map<number, number>();
    for (const t of toks) {
      const hits = new Set<number>();
      for (const [tok, ids] of this.index) {
        if (tokenMatch(tok, t) !== 'none') ids.forEach((i) => hits.add(i));
      }
      for (const i of hits) scores.set(i, (scores.get(i) ?? 0) + 1);
    }
    return [...scores.entries()]
      .filter(([, s]) => s === toks.length)
      .map(([i]) => this.rows[i])
      .sort((a, b) => a.name.length - b.name.length) // shorter names = more generic = better first guess
      .slice(0, limit);
  }
}

async function cachedDownload(name: string, url: string, maxAge = DAY): Promise<string> {
  await mkdir(CACHE_DIR, { recursive: true });
  const file = join(CACHE_DIR, name);
  try {
    const s = await stat(file);
    if (Date.now() - s.mtimeMs < maxAge) return await readFile(file, 'utf8');
  } catch {}
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(180_000), headers: { 'Accept-Encoding': 'gzip' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    const text = await res.text();
    await writeFile(file, text);
    return text;
  } catch (e) {
    // Serve stale data rather than nothing.
    try {
      return await readFile(file, 'utf8');
    } catch {
      throw e;
    }
  }
}

function lazy<T>(load: () => Promise<T>) {
  let p: Promise<T> | undefined;
  let at = 0;
  return () => {
    if (!p || Date.now() - at > DAY) {
      at = Date.now();
      p = load().catch((e) => {
        p = undefined;
        throw e;
      });
    }
    return p;
  };
}

function datasetConnector(info: StoreInfo, getCatalogue: () => Promise<Catalogue | undefined>): StoreConnector {
  return {
    info,
    async search(query, _ctx, limit = 12) {
      const cat = await getCatalogue();
      if (!cat) return [];
      return cat.search(query, limit).map((r): Offer => ({
        storeId: info.id, productId: r.id, name: r.name, price: r.price, currency: info.currency,
        pack: r.pack, unitPrice: unitPrice(r.price, r.pack), url: r.url, source: 'dataset',
      }));
    },
  };
}

// ───────────────────────────── checkjebon.nl (NL) ─────────────────────────────
const NL_CHAINS: Record<string, { name: string; url: (l: string) => string }> = {
  ah: { name: 'Albert Heijn', url: (l) => `https://www.ah.nl/producten/product/${l}` },
  jumbo: { name: 'Jumbo', url: (l) => `https://www.jumbo.com/producten/${l}` },
  lidl: { name: 'Lidl NL', url: (l) => `https://www.lidl.nl/p/${l}` },
  plus: { name: 'PLUS', url: (l) => `https://www.plus.nl/product/${l}` },
  dirk: { name: 'Dirk', url: (l) => `https://www.dirk.nl/boodschappen/x/x/${l}` },
  hoogvliet: { name: 'Hoogvliet', url: (l) => `https://www.hoogvliet.com/product/${l}` },
  spar: { name: 'SPAR NL', url: (l) => `https://www.spar.nl/${l}` },
  dekamarkt: { name: 'DekaMarkt', url: (l) => `https://www.dekamarkt.nl/producten/x/${l}` },
  poiesz: { name: 'Poiesz', url: (l) => `https://www.poiesz-supermarkten.nl/producten/${l}` },
  vomar: { name: 'Vomar', url: (l) => `https://www.vomar.nl/producten/${l}` },
  // aldi / ekoplaza exist in the feed but are empty as of 2026-11-08; they auto-register if they come back.
  aldi: { name: 'ALDI NL', url: (l) => `https://www.aldi.nl/product/${l}` },
  ekoplaza: { name: 'Ekoplaza', url: (l) => `https://www.ekoplaza.nl/nl/product/${l}` },
};

const checkjebon = lazy(async () => {
  const raw = JSON.parse(await cachedDownload('checkjebon.json', 'https://www.checkjebon.nl/data/supermarkets.json')) as Array<{ n: string; d: Array<{ n: string; l: string; p: number; s: string }> }>;
  const byChain = new Map<string, Catalogue>();
  for (const chain of raw) {
    const meta = NL_CHAINS[chain.n];
    if (!meta || !chain.d.length) continue;
    byChain.set(chain.n, new Catalogue(chain.d.filter((p) => p.p > 0).map((p) => ({
      id: p.l, name: p.n, price: Math.round(p.p * 100), pack: parseQuantity(p.s) ?? parseQuantity(p.n), url: meta.url(p.l),
    }))));
  }
  return byChain;
});

const NL_EMPTY = new Set(['aldi', 'ekoplaza']);
export const nlStores: StoreConnector[] = Object.entries(NL_CHAINS).filter(([key]) => !NL_EMPTY.has(key)).map(([key, meta]) =>
  datasetConnector(
    { id: `${key}-nl`, name: meta.name, chain: meta.name, country: 'NL', currency: 'EUR', language: 'nl', cart: key === 'ah' || key === 'jumbo' ? 'deeplink' : 'list', source: 'dataset', notes: 'checkjebon.nl daily dataset (national shelf prices).' },
    async () => (await checkjebon()).get(key),
  ),
);

// ───────────────────────────── heisse-preise.io (AT) ─────────────────────────────
const AT_STORES: Record<string, { name: string; base: string; stale?: string }> = {
  billa: { name: 'BILLA', base: 'https://shop.billa.at/produkte/' },
  // spar: feed stopped 2026-09-27 (all items unavailable) – re-enable when heisse-preise fixes its scraper.
};

function decodeHeisse(text: string, base: string): Row[] {
  const d = JSON.parse(text) as { data: any[] };
  const a = d.data;
  const rows: Row[] = [];
  let i = 0;
  while (i < a.length) {
    const [, id, name, , unavailable, nh] = a.slice(i, i + 6);
    i += 6;
    const latestPrice = a[i + 1]; // history is newest-first: [dateIdx, price, dateIdx, price, ...]
    i += 2 * nh;
    const [unit, quantity, isWeighted, , url] = a.slice(i, i + 5);
    i += 5;
    if (unavailable || !(latestPrice > 0)) continue;
    let pack: Quantity | undefined;
    try {
      if (quantity > 0) pack = mkq(quantity, unit === 'stk' ? 'pcs' : unit);
    } catch {}
    if (isWeighted && pack && pack.unit !== 'pcs') pack = { amount: 1000, unit: pack.unit }; // weighted => price per kg
    rows.push({ id: String(id), name: String(name).trim(), price: Math.round(latestPrice * 100), pack, url: url ? base + url : undefined });
  }
  return rows;
}

const heisse = Object.fromEntries(
  Object.entries(AT_STORES).map(([key, meta]) => [
    key,
    lazy(async () => new Catalogue(decodeHeisse(await cachedDownload(`heisse-${key}.json`, `https://heisse-preise.io/data/latest-canonical.${key}.compressed.json`), meta.base))),
  ]),
);

export const atStores: StoreConnector[] = Object.entries(AT_STORES).map(([key, meta]) =>
  datasetConnector(
    { id: `${key}-at`, name: meta.name, chain: meta.name, country: 'AT', currency: 'EUR', language: 'de', cart: 'list', source: 'dataset', notes: meta.stale ?? 'heisse-preise.io daily dataset.' },
    heisse[key],
  ),
);

/** Warm datasets at boot so the first user request is fast. */
export async function warmDatasets() {
  await Promise.allSettled([checkjebon(), ...Object.values(heisse).map((f) => f())]);
}
