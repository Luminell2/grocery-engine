import { lookup } from './ingredients.ts';
import { matchIngredient, type MatchOptions } from './matcher.ts';
import { convert } from './units.ts';
import type { BasketLine, BasketQuote, Ingredient, Meal, StoreConnector, StoreContext } from './types.ts';

/** Merge ingredients of several meals (Monday's breakfast + lunch...) into one shopping list. */
export function aggregate(meals: Array<Pick<Meal, 'ingredients'> & { servingsFactor?: number }>): Ingredient[] {
  const map = new Map<string, Ingredient>();
  for (const meal of meals) {
    const f = meal.servingsFactor ?? 1;
    for (const ing of meal.ingredients) {
      const entry = lookup(ing.name);
      const key = entry?.key ?? ing.name.toLowerCase().trim();
      const prev = map.get(key);
      const amount = ing.qty.amount * f;
      if (!prev) {
        map.set(key, { ...ing, name: entry?.key ?? ing.name, qty: { amount, unit: ing.qty.unit }, category: ing.category ?? entry?.category, pantry: ing.pantry ?? entry?.pantry });
        continue;
      }
      const add = convert({ amount, unit: ing.qty.unit }, prev.qty.unit, entry?.pieceG);
      if (add !== undefined) prev.qty = { amount: prev.qty.amount + add, unit: prev.qty.unit };
      else map.set(`${key}#${ing.qty.unit}`, { ...ing, qty: { amount, unit: ing.qty.unit } });
    }
  }
  return [...map.values()];
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

export async function quoteBasket(
  ingredients: Ingredient[],
  store: StoreConnector,
  ctx: StoreContext = {},
  opts: MatchOptions & { concurrency?: number } = {},
): Promise<BasketQuote> {
  const t0 = Date.now();
  const lines: BasketLine[] = await pool(ingredients, opts.concurrency ?? 4, (ing) =>
    matchIngredient(ing, store, ctx, opts).catch((e): BasketLine => ({
      ingredient: ing, packs: 0, cost: 0, alternatives: [], query: ing.name, status: 'error', error: String(e?.message ?? e),
    })),
  );
  const matched = lines.filter((l) => l.status === 'matched');
  return {
    store: store.info,
    currency: store.info.currency,
    total: matched.reduce((s, l) => s + l.cost, 0),
    usedCost: Math.round(matched.reduce((s, l) => s + l.cost * (l.usedFraction ?? 1), 0)),
    lines,
    matched: matched.length,
    missing: lines.length - matched.length,
    tookMs: Date.now() - t0,
  };
}

/**
 * Quote the same list at several stores and rank them. Stores missing items are ranked by an
 * estimated total (missing lines priced at the median matched line cost of that store) so a store
 * that "looks cheap" only because it didn't find the salmon doesn't win.
 */
export async function compareStores(
  ingredients: Ingredient[],
  stores: StoreConnector[],
  ctx: StoreContext = {},
  opts: MatchOptions = {},
) {
  const quotes = await Promise.all(stores.map((s) => quoteBasket(ingredients, s, ctx, opts)));
  const ranked = quotes
    .map((q) => {
      const costs = q.lines.filter((l) => l.status === 'matched').map((l) => l.cost).sort((a, b) => a - b);
      const median = costs.length ? costs[Math.floor(costs.length / 2)] : 0;
      return { ...q, estimatedTotal: q.total + q.missing * median, coverage: q.lines.length ? q.matched / q.lines.length : 0 };
    })
    .sort((a, b) => (b.coverage >= 0.8 ? 1 : 0) - (a.coverage >= 0.8 ? 1 : 0) || a.estimatedTotal - b.estimatedTotal);
  return { cheapest: ranked[0]?.store.id, quotes: ranked };
}
