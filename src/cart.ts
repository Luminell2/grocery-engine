// Cart handoff: turn a priced basket into something the user can order.
//
//  provider          region              cost to us           what the user gets
//  ───────────────── ─────────────────── ──────────────────── ─────────────────────────────────────────
//  instacart         US / CA             free (affiliate $)   Instacart page, picks store, 1-tap cart
//  pepesto-predirect EU (13 countries)   FREE (/predirect)    Pepesto app deep link, chooses supermarket,
//                                                             Pepesto fills the real supermarket cart
//  pepesto-checkout  EU                  €0.60–1.20/session   real cart in a specific chain (Tesco, AH,
//                                                             Rewe, Migros, Esselunga, Frisco...)
//  store-links       any store we price  free                 product links in the store web/app (Wolt,
//                                                             Mercadona, Rewe, Silpo, Frisco, AH, Jumbo)
//  text              anywhere            free                 share-sheet shopping list with prices

import { fetchJson } from './http.ts';
import { formatQty } from './units.ts';
import type { BasketQuote } from './types.ts';

export type CartProvider = 'instacart' | 'pepesto-predirect' | 'pepesto-checkout' | 'store-links' | 'text';

export interface CartResult {
  provider: CartProvider;
  url?: string;
  links?: Array<{ name: string; packs: number; url?: string }>;
  text?: string;
  note?: string;
}

const PEPESTO = 'https://s.pepesto.com/api';

/** Countries where Pepesto can fulfil a cart (from pepesto.com/supermarkets, Nov 2026). */
export const PEPESTO_COUNTRIES = ['GB', 'IE', 'NL', 'BE', 'CH', 'DE', 'IT', 'PL', 'BG', 'NO', 'DK', 'SE', 'PT'];

export function shoppingListLines(quote: Pick<BasketQuote, 'lines'>, withBrands = false): string[] {
  return quote.lines
    .filter((l) => l.packs > 0 || l.status !== 'matched')
    .map((l) => {
      const need = formatQty(l.ingredient.qty);
      if (withBrands && l.offer) return `${l.packs} x ${l.offer.name}`;
      return `${need} ${l.ingredient.name}`;
    });
}

export function money(minor: number, currency: string) {
  return new Intl.NumberFormat('en-IE', { style: 'currency', currency }).format(minor / 100);
}

export async function createCart(quote: BasketQuote, provider: CartProvider, opts: { title?: string; locale?: string; linkback?: string } = {}): Promise<CartResult> {
  switch (provider) {
    case 'pepesto-predirect': {
      // Free, public endpoint. Max 30 lines; newline-separated free text in the user's language.
      const list = shoppingListLines(quote).slice(0, 30).join('\n');
      const d = await fetchJson(`${PEPESTO}/predirect`, { body: { shopping_list: list, locale: opts.locale ?? 'en-GB' }, timeoutMs: 15000 });
      return { provider, url: d.redirect_url, note: 'User picks a supermarket in Pepesto and checks out there.' };
    }
    case 'pepesto-checkout': {
      const key = process.env.PEPESTO_API_KEY;
      if (!key) throw new Error('PEPESTO_API_KEY not set (buy credits at pepesto.com, POST /api/link to get a key)');
      const domain = PEPESTO_DOMAIN[quote.store.chain] ?? quote.store.id;
      const auth = { Authorization: `Bearer ${key}` };
      // 1) Resolve the list into concrete SKUs with session tokens (0.32 EUR with manual list).
      const products = await fetchJson(`${PEPESTO}/products`, {
        headers: auth, timeoutMs: 60000,
        body: { manual_shopping_list: shoppingListLines(quote).join('\n'), supermarket_domain: domain, item_names_locale: opts.locale ?? 'en' },
      });
      const skus = (products.items ?? []).flatMap((it: any) => (it.products ?? []).slice(0, 1).map((p: any) => ({ session_token: p.session_token, num_units_to_buy: p.num_units_to_buy || 1 })));
      // 2) White-label checkout handoff (0.60 EUR). After checkout the user returns to linkback with ?cartUrl=
      const session = await fetchJson(`${PEPESTO}/mcheckout`, {
        headers: auth, timeoutMs: 30000,
        body: { supermarket_domain: domain, user_locale: opts.locale ?? 'en', redirect_url: opts.linkback, skus, unresolved_items: (products.not_indexed_items ?? []).slice(0, 10) },
      });
      return { provider, url: session.mobile_hosted_url, note: `Pepesto session ${session.session_id}` };
    }
    case 'instacart': {
      const key = process.env.INSTACART_API_KEY;
      if (!key) throw new Error('INSTACART_API_KEY not set (apply at instacart.com/company/business/developers)');
      const base = process.env.INSTACART_ENV === 'production' ? 'https://connect.instacart.com' : 'https://connect.dev.instacart.tools';
      const d = await fetchJson(`${base}/idp/v1/products/products_link`, {
        headers: { Authorization: `Bearer ${key}` },
        body: {
          title: opts.title ?? 'Grocery list',
          link_type: 'shopping_list',
          // per docs: linkback lives in landing_page_configuration
          ...(opts.linkback ? { landing_page_configuration: { partner_linkback_url: opts.linkback } } : {}),
          line_items: quote.lines.map((l) => ({
            name: l.ingredient.name,
            display_text: l.ingredient.name,
            line_item_measurements: [{ quantity: l.ingredient.qty.unit === 'pcs' ? l.ingredient.qty.amount : Math.round(l.ingredient.qty.amount), unit: l.ingredient.qty.unit === 'pcs' ? 'each' : l.ingredient.qty.unit === 'g' ? 'gram' : 'milliliter' }],
          })),
        },
      });
      return { provider, url: d.products_link_url };
    }
    case 'store-links': {
      // Two ingredients can resolve to the same product (tzatziki -> greek yogurt): merge them.
      const byId = new Map<string, { name: string; packs: number; url?: string }>();
      for (const l of quote.lines) {
        if (!l.offer) continue;
        const prev = byId.get(l.offer.productId);
        if (prev) prev.packs += l.packs;
        else byId.set(l.offer.productId, { name: l.offer.name, packs: l.packs, url: l.offer.url });
      }
      const links = [...byId.values()];
      return { provider, links, note: `${quote.store.name}: open each product and add to cart (logged-in store session required).` };
    }
    case 'text':
    default: {
      const lines = quote.lines.map((l) => l.offer ? `☐ ${l.packs}× ${l.offer.name} — ${money(l.cost, quote.currency)}` : `☐ ${l.ingredient.name} (${formatQty(l.ingredient.qty)})`);
      return { provider: 'text', text: [`${quote.store.name} — ${money(quote.total, quote.currency)}`, ...lines].join('\n') };
    }
  }
}

/** Which handoff to offer first for a store / country. */
export function bestProvider(country: string, cartMode: string): CartProvider {
  if (country === 'US' || country === 'CA') return 'instacart';
  if (PEPESTO_COUNTRIES.includes(country)) return process.env.PEPESTO_API_KEY ? 'pepesto-checkout' : 'pepesto-predirect';
  return cartMode === 'deeplink' ? 'store-links' : 'text';
}

const PEPESTO_DOMAIN: Record<string, string> = {
  REWE: 'shop.rewe.de', 'Albert Heijn': 'ah.nl', Jumbo: 'jumbo.com', PLUS: 'plus.nl', Frisco: 'frisco.pl',
};
