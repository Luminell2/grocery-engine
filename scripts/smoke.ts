// Live smoke test: price Monday's meals at every connector and print what got matched.
// Usage: node scripts/smoke.ts [storeId ...] [--verbose]
import { readFile } from 'node:fs/promises';
import { aggregate, quoteBasket } from '../src/basket.ts';
import { money } from '../src/cart.ts';
import { getStore, listStores } from '../src/stores.ts';
import { formatQty } from '../src/units.ts';

const meals = JSON.parse(await readFile(new URL('../data/meals.json', import.meta.url), 'utf8'));
const monday = meals.filter((m: any) => ['falafel-wraps', 'homemade-burgers', 'egg-fried-rice', 'harissa-vegetables'].includes(m.id));
const list = aggregate(monday);
const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const ids = args.filter((a) => !a.startsWith('--'));
const stores = ids.length ? ids : ['mercadona-es', 'rewe-de', 'frisco-pl', 'silpo-ua', 'ah-nl', 'jumbo-nl', 'lidl-nl', 'billa-at', 'wolt-small-samal-2'];

console.log(`Monday list: ${list.length} ingredients; ${listStores().length} stores registered\n`);
const results = await Promise.all(stores.map(async (id) => {
  try {
    return await quoteBasket(list, getStore(id), {});
  } catch (e) {
    return { error: String(e), id };
  }
}));
for (const q of results as any[]) {
  if (q.error) {
    console.log(`✗ ${q.id}: ${q.error}`);
    continue;
  }
  console.log(`■ ${q.store.name} (${q.store.country}) total ${money(q.total, q.currency)}  used≈${money(q.usedCost, q.currency)}  matched ${q.matched}/${q.lines.length}  ${q.tookMs}ms`);
  for (const l of q.lines) {
    if (!verbose && l.status === 'matched') {
      console.log(`   ${l.ingredient.name.padEnd(16)} → ${l.packs}× ${l.offer.name.slice(0, 60)} ${money(l.offer.price, q.currency)}`);
    } else if (l.status !== 'matched') {
      console.log(`   ${l.ingredient.name.padEnd(16)} ✗ ${l.status} (q="${l.query}") ${l.error ?? ''}`);
    } else {
      console.log(`   ${l.ingredient.name.padEnd(16)} need ${formatQty(l.ingredient.qty)} → ${l.packs}× ${l.offer.name} [${l.offer.pack ? formatQty(l.offer.pack) : '?'}] ${money(l.offer.price, q.currency)} | alts: ${l.alternatives.slice(0, 3).map((a: any) => a.name).join(' / ')}`);
    }
  }
}
