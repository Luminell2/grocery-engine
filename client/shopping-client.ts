// Typed client for the Shopping tab (React Native / Expo / web). No dependencies: uses global fetch.
//
//   const api = new ShoppingClient('https://grocery.example.com');
//   const stores = await api.stores('NL');
//   const basket = await api.quote('ah-nl', mondayMeals);
//   const order  = await api.cart('ah-nl', { quote: basket });   // -> order.url (open in browser / app)
//
// Swift / Kotlin / Flutter: generate a client from ../openapi.yaml instead.

import type { BasketQuote, Ingredient, Meal, StoreContext, StoreInfo } from '../src/types.ts';
import type { PlanResult } from '../src/planner.ts';
import type { CartProvider, CartResult } from '../src/cart.ts';

export type { BasketQuote, Ingredient, Meal, StoreContext, StoreInfo, PlanResult, CartProvider, CartResult };

export interface CompareResult {
  cheapest?: string;
  quotes: Array<BasketQuote & { estimatedTotal: number; coverage: number }>;
}

export interface WoltVenueSummary {
  slug: string;
  name: string;
  country: string;
  countryPath: string;
  city: string;
  currency: string;
  online?: boolean;
  estimate?: string;
  rating?: number;
}

export class ShoppingApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class ShoppingClient {
  private base: string;
  private timeoutMs: number;
  constructor(baseUrl: string, opts: { timeoutMs?: number } = {}) {
    this.base = baseUrl.replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 60_000; // first quote at a new store can take a while (live prices)
  }

  private async req<T>(path: string, body?: unknown): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      const data = await res.json();
      if (!res.ok) throw new ShoppingApiError(res.status, data?.error ?? res.statusText);
      return data as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Stores the user can pick in a country (ISO alpha-2). */
  stores(country?: string) {
    return this.req<StoreInfo[]>(`/api/stores${country ? `?country=${encodeURIComponent(country)}` : ''}`);
  }

  /** Grocery venues on Wolt near the user — local stores in KZ, Baltics, Nordics, CEE... */
  woltVenues(lat: number, lon: number) {
    return this.req<{ city: string; country: string; venues: WoltVenueSummary[] }>(`/api/wolt/venues?lat=${lat}&lon=${lon}`);
  }

  /** Make a discovered Wolt venue quotable; returns its StoreInfo (id = "wolt-<slug>"). */
  registerWolt(venue: WoltVenueSummary) {
    return this.req<StoreInfo>('/api/wolt/register', venue);
  }

  /** Aggregate the selected day's meals into one shopping list (no prices). */
  list(meals: Meal[], people?: number) {
    return this.req<Ingredient[]>('/api/list', { meals, people });
  }

  /** Priced basket for the day at one store. */
  quote(storeId: string, meals: Meal[], opts: { people?: number; ctx?: StoreContext } = {}) {
    return this.req<BasketQuote>('/api/quote', { storeId, meals, ...opts });
  }

  /** Same basket at every store of a country (or given stores), cheapest first. */
  compare(target: { country: string } | { storeIds: string[] }, meals: Meal[], opts: { people?: number; ctx?: StoreContext } = {}) {
    return this.req<CompareResult>('/api/compare', { ...target, meals, ...opts });
  }

  /** Pick meals for the slots so the real basket fits the budget (minor units). */
  plan(storeId: string, input: { meals: Meal[]; slots: string[]; budget: number; people?: number; moods?: string[]; maxRepeats?: number; excludePantry?: boolean; ctx?: StoreContext }) {
    return this.req<PlanResult>('/api/plan', { storeId, ...input });
  }

  /** Turn a basket into an order link / product links / share text. Provider auto-picked by country if omitted. */
  cart(storeId: string, input: { quote?: BasketQuote; meals?: Meal[]; provider?: CartProvider; locale?: string; title?: string; linkback?: string; ctx?: StoreContext }) {
    return this.req<CartResult>('/api/cart', { storeId, ...input });
  }
}

/** Format minor units for display: formatMoney(1809, 'EUR') -> "€18.09". */
export function formatMoney(minor: number, currency: string, locale = 'en-IE') {
  const zeroDecimals = ['KZT', 'UAH', 'HUF', 'RSD'].includes(currency);
  return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: zeroDecimals ? 0 : 2 }).format(minor / 100);
}
