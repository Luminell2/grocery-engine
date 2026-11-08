// Coverage report: price the Monday basket (28 ingredients) at EVERY registered store and write
// data/coverage.json + data/COVERAGE.md. Usage: node scripts/coverage.ts
import { readFile, writeFile } from 'node:fs/promises';
import { aggregate, quoteBasket } from '../src/basket.ts';
import { money } from '../src/cart.ts';
import { getStore, listStores } from '../src/stores.ts';

const meals = JSON.parse(await readFile(new URL('../data/meals.json', import.meta.url), 'utf8'));
const list = aggregate(meals.filter((m: any) => ['falafel-wraps', 'homemade-burgers', 'egg-fried-rice', 'harissa-vegetables'].includes(m.id)));
const stores = listStores();
const rows: any[] = [];
let i = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (i < stores.length) {
    const s = stores[i++];
    const t0 = Date.now();
    try {
      const q = await quoteBasket(list, getStore(s.id), {}, { concurrency: 3 });
      const errors = q.lines.filter((l) => l.status === 'error').length;
      rows.push({ id: s.id, name: s.name, country: s.country, source: s.source, matched: q.matched, total: q.lines.length, errors, basket: money(q.total, q.currency), ms: Date.now() - t0 });
    } catch (e) {
      rows.push({ id: s.id, name: s.name, country: s.country, source: s.source, matched: 0, total: list.length, errors: list.length, basket: '—', ms: Date.now() - t0, error: String(e) });
    }
    console.log(`${s.id}: ${rows.at(-1).matched}/${list.length}`);
  }
}));
rows.sort((a, b) => a.country.localeCompare(b.country) || b.matched - a.matched);
const date = new Date().toISOString().slice(0, 10);
await writeFile(new URL('../data/coverage.json', import.meta.url), JSON.stringify({ date, ingredients: list.length, rows }, null, 2));
const md = [
  `# Coverage — ${date}`, '',
  `Monday basket (${list.length} ingredients: falafel wraps, burgers, egg fried rice, harissa vegetables) priced live at every store.`, '',
  '| Country | Store | Source | Matched | Basket (full packs) | Errors |', '|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.country} | ${r.name} | ${r.source} | ${r.matched}/${r.total} | ${r.basket} | ${r.errors || ''} |`),
].join('\n');
await writeFile(new URL('../data/COVERAGE.md', import.meta.url), md + '\n');
console.log(`\n${rows.filter((r) => r.matched >= list.length * 0.75).length}/${rows.length} stores matched ≥75% of the basket`);
