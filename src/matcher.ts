// Ingredient -> best product at a store.
// 1) translate ingredient into store language via the lexicon,
// 2) query the store, 3) score relevance (term coverage, exclusions, name position),
// 4) among the most relevant tier pick the cheapest way to cover the needed quantity.

import { lookup, termsFor } from './ingredients.ts';
import { fold, PREPOSITIONS, tokenize, tokenMatch } from './text.ts';
import { packsNeeded } from './units.ts';
import type { BasketLine, Ingredient, Offer, StoreConnector, StoreContext } from './types.ts';

/** Optional hook to translate unknown ingredients (e.g. an LLM call). Return search terms. */
export type Translator = (ingredient: string, language: string) => Promise<string[] | undefined>;

export interface MatchOptions {
  translate?: Translator;
  /** Max store queries per ingredient (each synonym is one query). */
  maxQueries?: number;
  /** internal: recursion guard for fallback ingredients */
  _fallbackDepth?: number;
}

// Non-food / not-an-ingredient words valid for every ingredient.
const GLOBAL_EXCLUDE = [
  'afwasmiddel', 'spulmittel', 'reiniger', 'waschmittel', 'wasmiddel', 'detergente', 'lavavajillas', 'suavizante', 'płyn', 'plyn do', 'средство', 'засіб',
  'шампунь', 'shampoo', 'shampooing', 'conditioner', 'apres-shampooing', 'мыло', 'мило', 'duschgel', 'douchegel', 'seife', 'zeep', 'jabon', 'tabletten', 'kerze', 'kaars', 'vela', 'świeca', 'свеча',
  'lufterfrischer', 'luchtverfrisser', 'ambientador', 'katzenfutter', 'hundefutter', 'kattenvoer', 'hondenvoer', 'pienso', 'karma', 'корм',
  // flavour / composite-dish markers ("Thé saveur citron", "Sandwich oeuf", "Street food saveur tzatziki")
  'saveur', 'aromatis', 'sandwich', 'croque', 'doritos', 'chips', 'crisps', 'sipsit', 'sipsi',
  'vitamini', 'bonbon', 'snoep', 'caramelo', 'cukierki', 'цукерки', 'конфеты', 'kaugummi', 'kauwgom', 'chicle', 'жвачка', 'lipbalm', 'lippenpflege',
];

export function relevance(offerName: string, terms: string[], exclude: string[] = [], language = 'en'): number {
  // Keep 1-letter tokens here: Slavic / Spanish prepositions ("w", "z", "с", "в", "y", "a").
  const folded = fold(offerName);
  const nameToks = folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const ex of [...exclude, ...GLOBAL_EXCLUDE]) {
    const e = fold(ex).trim();
    if (!e) continue;
    // Long exclusion words match as substrings (catch German compounds: "Schokoladenmilch"),
    // short ones only as token prefixes ("eis" must not kill "Reis").
    if (e.includes(' ') ? folded.includes(e) : e.length >= 5 ? folded.includes(e) : nameToks.some((t) => t.startsWith(e))) return 0;
  }
  const compounding = COMPOUND_LANGS.has(language);
  let best = 0;
  for (const term of terms) {
    // "carne picada de vacuno": the "de" must not be required in the product name.
    const termToks = tokenize(term).filter((t) => !PREPOSITIONS.has(t));
    if (!termToks.length) continue;
    let covered = 0;
    let modifierOnly = false;
    let firstIdx = -1;
    for (const [k, tt] of termToks.entries()) {
      const idx = nameToks.findIndex((t) => tokenMatch(t, tt) === 'head');
      if (idx >= 0) {
        covered++;
        if (k === 0) firstIdx = idx;
        continue;
      }
      const mIdx = nameToks.findIndex((t) => tokenMatch(t, tt) === 'modifier');
      if (mIdx >= 0) {
        // In German/Dutch/Estonian a compound starting with the term is a different product
        // (Zitronen|radler); in other languages it's usually just a longer inflection.
        covered += compounding ? 0.35 : 0.9;
        modifierOnly = modifierOnly || compounding;
        if (k === 0) firstIdx = mIdx;
      }
    }
    if (covered === 0) continue;
    let score = (covered / termToks.length) * 0.85;
    // Position bonus: the ingredient word appearing early ("Zwiebeln rot 1kg") beats appearing late.
    if (firstIdx >= 0) score += Math.max(0, 0.15 - firstIdx * 0.03);
    // "Mantecado de limón", "Sardinen in Sonnenblumenöl", "Nidos al huevo": ingredient after a
    // preposition is an attribute of another product.
    if (firstIdx > 0) {
      const before = nameToks.slice(0, firstIdx);
      const prepAt = before.findIndex((t) => PREPOSITIONS.has(t));
      // "Preparado de carne picada" / "Pack de huevos": generic packaging word before the preposition is fine.
      if (prepAt >= 0 && !before.slice(0, prepAt).every((t) => GENERIC_HEADS.has(t))) score *= 0.55;
    }
    if (modifierOnly) score *= 0.8;
    // Long product names are usually processed/composite products.
    score -= Math.min(0.25, Math.max(0, nameToks.length - 5) * 0.03);
    best = Math.max(best, score);
  }
  return Math.max(0, Math.min(1, best));
}

const GENERIC_HEADS = new Set(['preparado', 'preparat', 'pack', 'paquete', 'bandeja', 'bolsa', 'malla', 'red', 'caja', 'tarrina', 'bote', 'lata', 'tarro', 'zestaw', 'opakowanie', 'упаковка', 'набор', 'набір', 'netz', 'beutel', 'schale', 'zak', 'bakje', 'net']);
const COMPOUND_LANGS = new Set(['de', 'nl', 'et', 'sv', 'da', 'no', 'fi']);
/** Below this price (minor units) an offer is almost certainly a data error (€0.01 items). */
const MIN_PRICE = 10;
/** Half-covered multi-word terms ("олія соняшникова" vs "Олів'є") score ~0.57 and are rejected. */
const MIN_RELEVANCE = 0.6;

interface Scored {
  offer: Offer;
  rel: number;
  packs: number;
  cost: number;
  usedFraction?: number;
}

export async function matchIngredient(
  ing: Ingredient,
  store: StoreConnector,
  ctx: StoreContext,
  opts: MatchOptions = {},
): Promise<BasketLine> {
  const entry = lookup(ing.name);
  let terms = termsFor(ing.name, store.info.language);
  if (!entry && opts.translate) {
    const t = await opts.translate(ing.name, store.info.language).catch(() => undefined);
    if (t?.length) terms = t;
  }
  const exclude = entry?.exclude ?? [];
  const maxQueries = opts.maxQueries ?? 3;
  const scored: Scored[] = [];
  let lastErr: unknown;
  let usedQuery = terms[0];

  for (const term of terms.slice(0, maxQueries)) {
    let offers: Offer[];
    try {
      offers = await store.search(term, ctx, 16);
    } catch (e) {
      lastErr = e;
      continue;
    }
    for (const offer of offers) {
      if (offer.inStock === false || !(offer.price >= MIN_PRICE)) continue;
      const rel = relevance(offer.name, terms, exclude, store.info.language);
      if (rel < MIN_RELEVANCE) continue;
      const { packs, usedFraction } = packsNeeded(ing.qty, offer.pack, entry?.pieceG);
      // Unknown pack size: we can't verify it covers the need -> small penalty so known sizes win ties.
      const cost = packs * offer.price * (offer.pack ? 1 : 1.15);
      scored.push({ offer, rel, packs, cost, usedFraction });
    }
    if (scored.some((s) => s.rel >= 0.8)) {
      usedQuery = term;
      break;
    }
  }

  if (!scored.length) {
    // Not sold here -> try the broader ingredient (red onion -> onion), keep the original need.
    if (entry?.fallback && !opts._fallbackDepth) {
      const line = await matchIngredient({ ...ing, name: entry.fallback }, store, ctx, { ...opts, _fallbackDepth: 1 });
      if (line.status === 'matched') return { ...line, ingredient: ing, substitutedWith: entry.fallback };
    }
    return {
      ingredient: ing, packs: 0, cost: 0, alternatives: [], query: usedQuery,
      status: lastErr ? 'error' : 'not_found', error: lastErr ? String((lastErr as Error).message ?? lastErr) : undefined,
    };
  }

  // Dedupe (same product from two queries).
  const uniq = [...new Map(scored.map((s) => [s.offer.productId, s])).values()];
  const top = Math.max(...uniq.map((s) => s.rel));
  const tier = uniq.filter((s) => s.rel >= top - 0.12).sort((a, b) => a.cost - b.cost);
  const pick = tier[0];
  const alternatives = uniq
    .filter((s) => s !== pick)
    .sort((a, b) => b.rel - a.rel || a.cost - b.cost)
    .slice(0, 5)
    .map((s) => s.offer);

  return {
    ingredient: ing, offer: pick.offer, packs: pick.packs, cost: pick.packs * pick.offer.price,
    usedFraction: pick.usedFraction, alternatives, query: usedQuery, status: 'matched',
  };
}
