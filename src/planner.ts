// Budget planner: choose meals for the week's slots at a given store so the basket fits the budget.
// The cost of a set of meals is NOT additive: two recipes sharing a 1 kg bag of carrots cost less
// than the sum of their standalone prices. So we price each ingredient once (pack + price), then
// evaluate baskets exactly with pack rounding and run greedy construction + swap improvement.

import { aggregate } from './basket.ts';
import { lookup } from './ingredients.ts';
import { matchIngredient, type MatchOptions } from './matcher.ts';
import { packsNeeded } from './units.ts';
import type { BasketLine, Meal, StoreConnector, StoreContext } from './types.ts';

export interface PlanRequest {
  meals: Meal[];
  /** Slot labels, e.g. ["Mon Breakfast", "Mon Lunch", ...]; length = number of meals to plan. */
  slots: string[];
  /** Budget in minor units for the whole plan. */
  budget: number;
  /** How many people (scales recipe servings). */
  people?: number;
  /** Preferred meal tags ("Speedy Meals", "Family Favs"). Matching meals get a cost discount in ranking. */
  moods?: string[];
  maxRepeats?: number;
  /** Ignore pantry staples (oil, salt...) in cost: most users already have them. */
  excludePantry?: boolean;
}

export interface PlanResult {
  store: StoreConnector['info'];
  currency: string;
  budget: number;
  total: number;
  fits: boolean;
  slots: Array<{ slot: string; mealId: string; title: string; estCost: number }>;
  lines: BasketLine[];
  unpricedIngredients: string[];
}

type PriceBook = Map<string, BasketLine>;

function basketCost(meals: Meal[], book: PriceBook, people: number, excludePantry: boolean): number {
  const list = aggregate(meals.map((m) => ({ ingredients: m.ingredients, servingsFactor: people / (m.servings || 1) })));
  let total = 0;
  for (const ing of list) {
    if (excludePantry && ing.pantry) continue;
    const line = book.get(lookup(ing.name)?.key ?? ing.name.toLowerCase());
    if (!line?.offer) continue;
    total += packsNeeded(ing.qty, line.offer.pack, lookup(ing.name)?.pieceG).packs * line.offer.price;
  }
  return total;
}

export async function planWithinBudget(req: PlanRequest, store: StoreConnector, ctx: StoreContext = {}, opts: MatchOptions = {}): Promise<PlanResult> {
  const people = req.people ?? 1;
  const maxRepeats = req.maxRepeats ?? 2;
  const excludePantry = req.excludePantry ?? false;
  const moods = new Set((req.moods ?? []).map((m) => m.toLowerCase()));

  // 1. Price every distinct ingredient once.
  const all = aggregate(req.meals.map((m) => ({ ingredients: m.ingredients })));
  const book: PriceBook = new Map();
  const queue = [...all];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let ing = queue.shift(); ing; ing = queue.shift()) {
      const line = await matchIngredient(ing, store, ctx, opts);
      book.set(lookup(ing.name)?.key ?? ing.name.toLowerCase(), line);
    }
  }));
  const unpriced = [...book.values()].filter((l) => !l.offer).map((l) => l.ingredient.name);

  // Meals whose key ingredients can't be bought here are not plannable at this store.
  const plannable = req.meals.filter((m) => m.ingredients.every((i) => i.pantry || lookup(i.name)?.pantry || book.get(lookup(i.name)?.key ?? i.name.toLowerCase())?.offer));
  const pool = plannable.length ? plannable : req.meals;
  const moodFactor = (m: Meal) => (m.tags?.some((t) => moods.has(t.toLowerCase())) ? 0.85 : 1);
  const cost = (ms: Meal[]) => basketCost(ms, book, people, excludePantry);

  // 2. Greedy: fill each slot with the meal adding the least marginal cost (variety-penalized).
  const chosen: Meal[] = [];
  const count = new Map<string, number>();
  for (let s = 0; s < req.slots.length; s++) {
    const base = cost(chosen);
    let best: Meal | undefined;
    let bestScore = Infinity;
    for (const m of pool) {
      const used = count.get(m.id) ?? 0;
      if (used >= maxRepeats) continue;
      const marginal = cost([...chosen, m]) - base;
      const score = marginal * moodFactor(m) * (1 + 0.6 * used);
      if (score < bestScore) (bestScore = score), (best = m);
    }
    if (!best) best = pool[s % pool.length];
    chosen.push(best);
    count.set(best.id, (count.get(best.id) ?? 0) + 1);
  }

  // 3. Swap improvement: replace any slot with any meal if it lowers total cost (respecting repeats).
  for (let pass = 0; pass < 3; pass++) {
    let improved = false;
    for (let s = 0; s < chosen.length; s++) {
      const current = cost(chosen);
      for (const m of pool) {
        if (m.id === chosen[s].id || (count.get(m.id) ?? 0) >= maxRepeats) continue;
        const trial = chosen.slice();
        trial[s] = m;
        if (cost(trial) * 1.0 < current * 0.995) {
          count.set(chosen[s].id, count.get(chosen[s].id)! - 1);
          count.set(m.id, (count.get(m.id) ?? 0) + 1);
          chosen[s] = m;
          improved = true;
          break;
        }
      }
    }
    if (!improved) break;
  }

  // Order doesn't change the basket price, so spread repeats out (no "oats, oats" back to back).
  spreadRepeats(chosen);
  const total = cost(chosen);
  const lines = aggregate(chosen.map((m) => ({ ingredients: m.ingredients, servingsFactor: people / (m.servings || 1) })))
    .filter((ing) => !(excludePantry && ing.pantry))
    .map((ing) => {
      const priced = book.get(lookup(ing.name)?.key ?? ing.name.toLowerCase());
      if (!priced?.offer) return { ...(priced ?? { alternatives: [], query: ing.name, status: 'not_found' as const }), ingredient: ing, packs: 0, cost: 0 };
      const { packs, usedFraction } = packsNeeded(ing.qty, priced.offer.pack, lookup(ing.name)?.pieceG);
      return { ...priced, ingredient: ing, packs, usedFraction, cost: packs * priced.offer.price };
    });

  return {
    store: store.info,
    currency: store.info.currency,
    budget: req.budget,
    total,
    fits: total <= req.budget,
    slots: chosen.map((m, i) => ({ slot: req.slots[i], mealId: m.id, title: m.title, estCost: cost([m]) })),
    lines,
    unpricedIngredients: unpriced,
  };
}

/** Reorder in place so identical meals are as far apart as possible (greedy most-remaining-first). */
function spreadRepeats(meals: Meal[]) {
  const left = new Map<string, { meal: Meal; n: number }>();
  for (const m of meals) {
    const e = left.get(m.id);
    if (e) e.n++;
    else left.set(m.id, { meal: m, n: 1 });
  }
  const out: Meal[] = [];
  while (out.length < meals.length) {
    const prev = out[out.length - 1]?.id;
    const pick = [...left.values()].filter((e) => e.n > 0 && (e.meal.id !== prev || left.size === 1)).sort((a, b) => b.n - a.n)[0]
      ?? [...left.values()].find((e) => e.n > 0)!;
    out.push(pick.meal);
    pick.n--;
  }
  meals.splice(0, meals.length, ...out);
}
