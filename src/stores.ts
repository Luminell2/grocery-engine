import { atStores, nlStores } from './connectors/datasets.ts';
import { frisco, mercadona, rewe, silpo, woltVenue } from './connectors/live.ts';
import { moreStores } from './connectors/more.ts';
import { openPricesStores } from './connectors/openprices.ts';
import type { StoreConnector } from './types.ts';

// Preset Wolt grocery venues (Almaty). Any other venue can be added at runtime via registerWolt().
const KZ_WOLT = [
  { slug: 'small-samal-2', name: 'Small (Samal-2)', chain: 'Small' },
  { slug: 'small-tole-bi', name: 'Eurospar Tole bi', chain: 'Eurospar' },
  { slug: 'galmart-forum', name: 'galmart Forum', chain: 'galmart' },
  { slug: 'airba-express-zhandosova', name: 'Airba Express', chain: 'Airba Fresh' },
  { slug: 'wolt-market-gorniy-gigant', name: 'Wolt Market', chain: 'Wolt Market' },
].map((v) => woltVenue({ ...v, country: 'KZ', currency: 'KZT', language: 'ru', url: `https://wolt.com/ru/kaz/almaty/venue/${v.slug}` }));

const registry = new Map<string, StoreConnector>();
for (const s of [mercadona, rewe, frisco, silpo, ...nlStores, ...atStores, ...moreStores, ...openPricesStores, ...KZ_WOLT]) registry.set(s.info.id, s);

export function getStore(id: string): StoreConnector {
  const s = registry.get(id);
  if (!s) throw Object.assign(new Error(`Unknown store "${id}"`), { status: 404 });
  return s;
}

export function listStores(country?: string) {
  return [...registry.values()].map((s) => s.info).filter((s) => !country || s.country === country.toUpperCase());
}

export function storesFor(country: string) {
  return [...registry.values()].filter((s) => s.info.country === country.toUpperCase());
}

// Wolt search works best in the venue's primary language (that's what our lexicon translates to).
const COUNTRY_LANG: Record<string, string> = {
  PL: 'pl', DE: 'de', AT: 'de', EE: 'et', KZ: 'ru', UA: 'uk', NL: 'nl', ES: 'es', FR: 'fr', IT: 'it', LV: 'ru', LT: 'en',
  FI: 'en', SE: 'en', NO: 'en', DK: 'en', CZ: 'en', SK: 'en', HU: 'en', HR: 'en', SI: 'en', RS: 'en', GR: 'en', CY: 'en', GE: 'en', AZ: 'ru', UZ: 'ru',
};

/** Register any Wolt grocery venue discovered via /api/wolt/venues (covers ~25 countries). */
export function registerWolt(v: { slug: string; name: string; country: string; currency: string; language?: string; countryPath?: string; city?: string }) {
  const c = woltVenue({
    slug: v.slug, name: v.name, chain: v.name, country: v.country.toUpperCase(), currency: v.currency, language: v.language ?? COUNTRY_LANG[v.country.toUpperCase()] ?? 'en',
    url: `https://wolt.com/en/${v.countryPath ?? v.country.toLowerCase()}/${v.city ?? 'city'}/venue/${v.slug}`,
  });
  registry.set(c.info.id, c);
  return c.info;
}
