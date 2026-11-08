import type { Quantity, Unit } from './types.ts';

// Unit aliases across the languages of the stores we support.
const UNIT_ALIASES: Record<string, [Unit, number]> = {
  // mass -> grams
  g: ['g', 1], gr: ['g', 1], gram: ['g', 1], gramm: ['g', 1], grams: ['g', 1], gramos: ['g', 1], 'г': ['g', 1], 'гр': ['g', 1],
  kg: ['g', 1000], kilo: ['g', 1000], kilogram: ['g', 1000], kilogramm: ['g', 1000], 'кг': ['g', 1000],
  mg: ['g', 0.001],
  oz: ['g', 28.35], lb: ['g', 453.6],
  // volume -> ml
  ml: ['ml', 1], 'мл': ['ml', 1],
  cl: ['ml', 10], dl: ['ml', 100],
  l: ['ml', 1000], lt: ['ml', 1000], ltr: ['ml', 1000], liter: ['ml', 1000], litre: ['ml', 1000], litro: ['ml', 1000], litros: ['ml', 1000], 'л': ['ml', 1000],
  // pieces
  pcs: ['pcs', 1], pc: ['pcs', 1], piece: ['pcs', 1], pieces: ['pcs', 1], st: ['pcs', 1], stk: ['pcs', 1], 'stück': ['pcs', 1],
  stuk: ['pcs', 1], stuks: ['pcs', 1], szt: ['pcs', 1], 'шт': ['pcs', 1], ud: ['pcs', 1], uds: ['pcs', 1], unidad: ['pcs', 1],
  unidades: ['pcs', 1], tk: ['pcs', 1], each: ['pcs', 1],
  // cooking units (recipes)
  tsp: ['ml', 5], teaspoon: ['ml', 5], tbsp: ['ml', 15], tablespoon: ['ml', 15], cup: ['ml', 240], cups: ['ml', 240],
};

const NUM = String.raw`(\d+(?:[.,]\d+)?)`;
const UNIT_RE = Object.keys(UNIT_ALIASES).sort((a, b) => b.length - a.length).map(escapeRe).join('|');
// "6 x 1,5 l", "6x330ml", "4 × 125 g"
const MULTI_RE = new RegExp(String.raw`(\d+)\s*[x×*]\s*${NUM}\s*(${UNIT_RE})(?![\p{L}])`, 'iu');
const SINGLE_RE = new RegExp(String.raw`${NUM}\s*(${UNIT_RE})(?![\p{L}])`, 'iu');

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function num(s: string) {
  return parseFloat(s.replace(',', '.'));
}

export function unitFromAlias(alias: string): [Unit, number] | undefined {
  return UNIT_ALIASES[alias.toLowerCase().replace(/\.$/, '')];
}

/** Parse a pack size out of free text: "0,75 l", "Milch 3,5% 1l", "6 x 33 cl", "per stuk". */
export function parseQuantity(text: string | undefined | null): Quantity | undefined {
  if (!text) return undefined;
  // Drop base-price annotations: "1 Stück ca. 100 g (1 kg = 13,90 €)", "500 g (€9.98/kg)", "per kg".
  const t = text
    .replace(/ /g, ' ')
    .replace(/\([^)]*(=|€|\/)[^)]*\)/g, ' ')
    .replace(/\d+(?:[.,]\d+)?\s*(?:€|eur|zł|pln|грн|₸)\s*\/\s*\p{L}+/giu, ' ');
  const m = MULTI_RE.exec(t);
  if (m) {
    const [unit, f] = UNIT_ALIASES[m[3].toLowerCase()];
    return { amount: round(num(m[1]) * num(m[2]) * f), unit };
  }
  // First mass/volume mention wins ("Milch 3,5% 1l"); pieces only if nothing else
  // ("1 Stück ca. 100 g" -> 100 g, "Eier 6 Stück" -> 6 pcs).
  let pieces: Quantity | undefined;
  for (const mm of t.matchAll(new RegExp(SINGLE_RE.source, 'giu'))) {
    const [unit, f] = UNIT_ALIASES[mm[2].toLowerCase()];
    const amount = num(mm[1]) * f;
    if (!(amount > 0)) continue;
    if (unit !== 'pcs') return { amount: round(amount), unit };
    pieces ??= { amount: round(amount), unit };
  }
  if (pieces) return pieces;
  // JS \b is ASCII-only, so use Unicode letter lookarounds (needed for "шт").
  if (/(?<!\p{L})(per stuk|per piece|each|stuk|stück|шт|szt|ud)(?!\p{L})/iu.test(t)) return { amount: 1, unit: 'pcs' };
  return undefined;
}

export function q(amount: number, unit: string): Quantity {
  const a = unitFromAlias(unit);
  if (!a) throw new Error(`Unknown unit "${unit}"`);
  return { amount: round(amount * a[1]), unit: a[0] };
}

function round(n: number) {
  return Math.round(n * 1000) / 1000;
}

/**
 * Convert a quantity into the target unit. Mass<->volume assumes density 1 (good enough for
 * shopping: milk, yogurt, oil ~0.92). Pieces<->mass needs an average item weight.
 */
export function convert(from: Quantity, to: Unit, avgPieceGrams?: number): number | undefined {
  if (from.unit === to) return from.amount;
  const massLike = (u: Unit) => u === 'g' || u === 'ml';
  if (massLike(from.unit) && massLike(to)) return from.amount;
  if (!avgPieceGrams) return undefined;
  if (from.unit === 'pcs' && massLike(to)) return from.amount * avgPieceGrams;
  if (massLike(from.unit) && to === 'pcs') return from.amount / avgPieceGrams;
  return undefined;
}

/** How many packs to buy to cover the need. Unknown pack size => 1 pack (and caller flags it). */
export function packsNeeded(need: Quantity, pack: Quantity | undefined, avgPieceGrams?: number) {
  if (!pack || pack.amount <= 0) return { packs: 1, usedFraction: undefined as number | undefined };
  const needInPackUnit = convert(need, pack.unit, avgPieceGrams);
  if (needInPackUnit === undefined) return { packs: 1, usedFraction: undefined };
  // 3% tolerance: needing 1010 g of a 1 kg pack still means one pack.
  const packs = Math.max(1, Math.ceil(needInPackUnit / pack.amount - 0.03));
  return { packs, usedFraction: Math.min(1, needInPackUnit / (packs * pack.amount)) };
}

/** Price per kg / l / piece (minor units). */
export function unitPrice(price: number, pack?: Quantity): number | undefined {
  if (!pack || pack.amount <= 0) return undefined;
  const base = pack.unit === 'pcs' ? 1 : 1000;
  return Math.round((price / pack.amount) * base);
}

export function formatQty(x: Quantity): string {
  if (x.unit === 'pcs') return `${+x.amount.toFixed(2)} pcs`;
  if (x.amount >= 1000) return `${+(x.amount / 1000).toFixed(2)} ${x.unit === 'g' ? 'kg' : 'l'}`;
  return `${Math.round(x.amount)} ${x.unit}`;
}
