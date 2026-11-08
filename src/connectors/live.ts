// Live store connectors: query the store's own (public, unauthenticated) web/app search API.
// Each returns normalized Offers. They are intentionally small: when a store changes its API
// only one function needs fixing, and tests/smoke.ts tells you which one broke.

import { fetchJson, HOUR } from '../http.ts';
import { parseQuantity, unitPrice } from '../units.ts';
import type { Offer, Quantity, StoreConnector, StoreContext } from '../types.ts';

const SEARCH_CACHE = 6 * HOUR;
const cents = (eur: number | string) => Math.round(Number(eur) * 100);

function offer(o: Omit<Offer, 'unitPrice'>): Offer {
  return { ...o, unitPrice: unitPrice(o.price, o.pack) };
}

// ───────────────────────────── Mercadona (ES) ─────────────────────────────
// tienda.mercadona.es search is Algolia with a public search-only key embedded in the web app.
// Index is per warehouse ("mad1", "bcn1", "vlc1", "svq1", ...) -> pass ctx.branchId to localize.
const MERCADONA_ALGOLIA = {
  app: '7UZJKL1DJ0',
  key: '9d8f2e39e90df472b4f2e559a116fe17',
};

export const mercadona: StoreConnector = {
  info: {
    id: 'mercadona-es', name: 'Mercadona', chain: 'Mercadona', country: 'ES', currency: 'EUR', language: 'es',
    cart: 'deeplink', source: 'live', notes: 'Algolia public index; warehouse via branchId (default mad1).',
  },
  async search(query, ctx, limit = 12) {
    const wh = ctx.branchId ?? 'mad1';
    const url = `https://${MERCADONA_ALGOLIA.app.toLowerCase()}-dsn.algolia.net/1/indexes/products_prod_${wh}_es/query` +
      `?x-algolia-application-id=${MERCADONA_ALGOLIA.app}&x-algolia-api-key=${MERCADONA_ALGOLIA.key}`;
    const d = await fetchJson(url, { body: { params: `query=${encodeURIComponent(query)}&hitsPerPage=${limit}` }, cacheMs: SEARCH_CACHE });
    return (d.hits ?? []).map((h: any): Offer => {
      const pi = h.price_instructions ?? {};
      const fmt = String(pi.size_format ?? '').toLowerCase();
      const size = Number(pi.unit_size);
      let pack: Quantity | undefined;
      if (size > 0) {
        if (fmt === 'kg') pack = { amount: size * 1000, unit: 'g' };
        else if (fmt === 'l') pack = { amount: size * 1000, unit: 'ml' };
        else if (fmt === 'ud') pack = { amount: size, unit: 'pcs' };
      }
      return offer({
        storeId: 'mercadona-es', productId: String(h.id), name: h.display_name, brand: h.brand,
        price: cents(pi.unit_price), regularPrice: pi.previous_unit_price ? cents(pi.previous_unit_price) : undefined,
        currency: 'EUR', pack, url: h.share_url, image: h.thumbnail, source: 'live', inStock: h.published !== false,
      });
    });
  },
};

// ───────────────────────────── REWE (DE) ─────────────────────────────
// shop.rewe.de JSON API. Prices are per market: resolve postal code -> market wwIdent, send as cookie.
const reweMarketCache = new Map<string, string>();

async function reweMarket(ctx: StoreContext): Promise<string> {
  if (ctx.branchId) return ctx.branchId;
  const zip = ctx.postalCode ?? '10115';
  const cached = reweMarketCache.get(zip);
  if (cached) return cached;
  const markets = await fetchJson<any[]>(`https://shop.rewe.de/api/marketselection/zipcodes/${zip}/services/pickup`, { cacheMs: 24 * HOUR });
  const id = markets?.[0]?.wwIdent;
  if (!id) throw new Error(`No REWE market for postal code ${zip}`);
  reweMarketCache.set(zip, id);
  return id;
}

export const rewe: StoreConnector = {
  info: {
    id: 'rewe-de', name: 'REWE', chain: 'REWE', country: 'DE', currency: 'EUR', language: 'de',
    cart: 'deeplink', source: 'live', needs: ['postalCode'], notes: 'Market-specific prices (pickup market nearest to postal code).',
  },
  async search(query, ctx, limit = 12) {
    const market = await reweMarket(ctx);
    const d = await fetchJson(
      `https://shop.rewe.de/api/products?search=${encodeURIComponent(query)}&objectsPerPage=${limit}&serviceTypes=PICKUP&market=${market}`,
      { headers: { Cookie: `wwIdent=${market}` }, cacheMs: SEARCH_CACHE },
    );
    const out: Offer[] = [];
    for (const p of d?._embedded?.products ?? []) {
      const art = p._embedded?.articles?.[0]?._embedded?.listing;
      const price = art?.pricing?.currentRetailPrice;
      if (price == null) continue;
      out.push(offer({
        storeId: 'rewe-de', productId: String(p.id), name: p.productName, brand: p.brand?.name, price,
        regularPrice: art.pricing.regularPrice ?? undefined, currency: art.pricing.currency ?? 'EUR',
        pack: parseQuantity(art.pricing.grammage) ?? parseQuantity(p.productName),
        url: p._links?.detail?.href ? `https://shop.rewe.de${p._links.detail.href}` : undefined,
        image: p.media?.images?.[0]?._links?.self?.href, gtin: p._embedded?.articles?.[0]?.gtin, source: 'live',
      }));
    }
    return out;
  },
};

// ───────────────────────────── Frisco (PL) ─────────────────────────────
export const frisco: StoreConnector = {
  info: {
    id: 'frisco-pl', name: 'Frisco', chain: 'Frisco', country: 'PL', currency: 'PLN', language: 'pl',
    cart: 'deeplink', source: 'live', notes: 'Online grocer (Warsaw, Kraków, Wrocław, Poznań...).',
  },
  async search(query, _ctx, limit = 12) {
    const d = await fetchJson(
      `https://www.frisco.pl/app/commerce/api/v1/offer/products/query?purpose=Listing&pageIndex=1&search=${encodeURIComponent(query)}&pageSize=${limit}`,
      { cacheMs: SEARCH_CACHE },
    );
    return (d.products ?? []).map(({ product: p }: any): Offer => {
      const uom = String(p.unitOfMeasure ?? '').toLowerCase();
      const g = Number(p.grammage);
      let pack: Quantity | undefined;
      if (g > 0) {
        if (uom.startsWith('kilo')) pack = { amount: g * 1000, unit: 'g' };
        else if (uom.startsWith('lit')) pack = { amount: g * 1000, unit: 'ml' };
        else if (uom.startsWith('piece') || uom.startsWith('szt')) pack = { amount: g, unit: 'pcs' };
      }
      const promo = p.price?.promotionalPrice ?? p.price?.priceAfterPromotion;
      return offer({
        storeId: 'frisco-pl', productId: String(p.productId), name: p.name?.pl ?? p.name?.en, brand: p.brand,
        price: cents(promo ?? p.price?.price), regularPrice: promo ? cents(p.price?.price) : undefined,
        currency: 'PLN', pack: pack ?? parseQuantity(p.name?.pl), image: p.imageUrl, gtin: p.ean,
        url: `https://www.frisco.pl/pid,${p.productId}/n,${slug(p.name?.pl ?? '')}`, inStock: p.isAvailable, source: 'live',
      });
    });
  },
};

// ───────────────────────────── Silpo (UA) ─────────────────────────────
// Silpo e-com API. Zero-UUID branch = default (Kyiv) assortment; pass a real branchId for city pricing.
export const silpo: StoreConnector = {
  info: {
    id: 'silpo-ua', name: 'Сільпо', chain: 'Silpo', country: 'UA', currency: 'UAH', language: 'uk',
    cart: 'deeplink', source: 'live', notes: 'Default branch = Kyiv online assortment.',
  },
  async search(query, ctx, limit = 12) {
    const branch = ctx.branchId ?? '00000000-0000-0000-0000-000000000000';
    const d = await fetchJson(
      `https://sf-ecom-api.silpo.ua/v1/uk/branches/${branch}/products?limit=${Math.max(limit, 60)}&offset=0&search=${encodeURIComponent(query)}&inStock=true`,
      { cacheMs: SEARCH_CACHE },
    );
    return (d.items ?? []).map((p: any): Offer => {
      // displayRatio is "150г" / "1л" / "кг" (weighted: price per kg) / "шт".
      let pack = parseQuantity(p.displayRatio) ?? parseQuantity(p.title);
      if (!pack && /кг/.test(p.displayRatio ?? p.ratio ?? '')) pack = { amount: 1000, unit: 'g' };
      return offer({
        storeId: 'silpo-ua', productId: String(p.id), name: p.title, brand: p.brandTitle,
        price: cents(p.displayPrice ?? p.price), regularPrice: p.displayOldPrice ? cents(p.displayOldPrice) : undefined,
        currency: 'UAH', pack, url: `https://silpo.ua/product/${p.slug}`,
        image: p.icon ? `https://images.silpo.ua/products/300x300/webp/${p.icon.replace(/\.png$/, '.webp')}` : undefined,
        inStock: (p.stock ?? 1) > 0, source: 'live',
      });
    });
  },
};

// ───────────────────────────── Wolt venues (KZ, GE, EE, LV, LT, FI, SE, NO, DK, DE, PL, CZ, SK, HU, HR, SI, RS, GR, CY, MT, AT, LU, AZ, UZ ...) ─────────
// Wolt's consumer API exposes every grocery venue's assortment search. One connector instance per
// venue (Small/Eurospar, galmart, Airba in Almaty; EDEKA/Flink/Knuspr in Berlin; Coop/Prisma in the Nordics...).
export interface WoltVenue {
  slug: string;
  name: string;
  chain: string;
  country: string;
  currency: string;
  language: string;
  /** Public venue page, e.g. https://wolt.com/en/kaz/almaty/venue/small-samal-2 */
  url: string;
}

export function woltVenue(v: WoltVenue): StoreConnector {
  const id = `wolt-${v.slug}`;
  return {
    info: {
      id, name: v.name, chain: v.chain, country: v.country, currency: v.currency, language: v.language,
      cart: 'deeplink', source: 'live', notes: `Wolt venue ${v.slug}; order is placed in Wolt app/web.`,
    },
    async search(query, _ctx, limit = 12) {
      const d = await fetchJson(
        `https://consumer-api.wolt.com/consumer-api/consumer-assortment/v1/venues/slug/${v.slug}/assortment/items/search?language=${v.language}`,
        { body: { q: query }, cacheMs: SEARCH_CACHE },
      );
      return (d.items ?? []).slice(0, limit).map((it: any): Offer => {
        // Sold by weight: price is per kg and the customer orders in steps (e.g. 300 g).
        // Model one step as one "pack" so pack rounding works like any other product.
        const w = it.sell_by_weight_config;
        const step = Number(w?.grams_per_step) || 0;
        const byWeight = w?.price_per_kg && step > 0;
        return offer({
          storeId: id, productId: String(it.id), name: it.name,
          price: byWeight ? Math.round((w.price_per_kg * step) / 1000) : it.price,
          regularPrice: it.original_price ?? undefined, currency: v.currency,
          pack: byWeight ? { amount: step, unit: 'g' } : parseQuantity(it.name) ?? parseQuantity(it.unit_info),
          url: `${v.url}/itemid-${it.id}`, image: it.images?.[0]?.url, gtin: it.barcode_gtin ?? undefined,
          inStock: (it.purchasable_balance ?? 1) > 0, source: 'live',
        });
      });
    },
  };
}

/** Discover grocery venues around a point (used to offer local stores in KZ / Baltics / Nordics ...). */
export async function discoverWoltVenues(lat: number, lon: number) {
  const d = await fetchJson(`https://restaurant-api.wolt.com/v1/pages/front?lat=${lat}&lon=${lon}`, { cacheMs: 6 * HOUR });
  const found = new Map<string, any>();
  const walk = (o: any) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (o && typeof o === 'object') {
      const v = o.venue;
      if (v?.slug && v.product_line === 'grocery') found.set(v.slug, { slug: v.slug, name: v.name, country: d.city_data?.country_code_alpha2 ?? v.country, countryPath: String(v.country ?? '').toLowerCase(), city: d.city, currency: v.currency, online: v.online, estimate: v.estimate_range, rating: v.rating?.score });
      Object.values(o).forEach(walk);
    }
  };
  walk(d);
  return { city: d.city, country: d.city_data?.country_code_alpha2, venues: [...found.values()] };
}

function slug(s: string) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
