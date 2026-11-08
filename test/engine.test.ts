import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuantity, packsNeeded, q, unitPrice } from '../src/units.ts';
import { tokenMatch } from '../src/text.ts';
import { relevance, matchIngredient } from '../src/matcher.ts';
import { aggregate, compareStores, quoteBasket } from '../src/basket.ts';
import { planWithinBudget } from '../src/planner.ts';
import { createCart, bestProvider, shoppingListLines } from '../src/cart.ts';
import type { Meal, Offer, StoreConnector } from '../src/types.ts';

test('parseQuantity handles store formats in many languages', () => {
  assert.deepEqual(parseQuantity('0,75 l'), { amount: 750, unit: 'ml' });
  assert.deepEqual(parseQuantity('Hemme Milch Frische Vollmilch 3,7% 1l'), { amount: 1000, unit: 'ml' });
  assert.deepEqual(parseQuantity('6 x 33 cl'), { amount: 1980, unit: 'ml' });
  assert.deepEqual(parseQuantity('2*100г'), { amount: 200, unit: 'g' });
  assert.deepEqual(parseQuantity('Масло подсолнечное Майское 875 мл'), { amount: 875, unit: 'ml' });
  assert.deepEqual(parseQuantity('1 Stück ca. 100 g (1 kg = 13,90 €)'), { amount: 100, unit: 'g' });
  assert.deepEqual(parseQuantity('Per 700 ml'), { amount: 700, unit: 'ml' });
  assert.deepEqual(parseQuantity('6 Stuks'), { amount: 6, unit: 'pcs' });
  assert.deepEqual(parseQuantity('Яйцо 10 шт'), { amount: 10, unit: 'pcs' });
  assert.deepEqual(parseQuantity('per stuk'), { amount: 1, unit: 'pcs' });
  assert.equal(parseQuantity('2 large onions'), undefined); // "l" must not match inside "large"
});

test('packsNeeded converts pieces via average weight and rounds up', () => {
  assert.deepEqual(packsNeeded(q(2, 'pcs'), q(1, 'kg'), 70).packs, 1); // 2 carrots from a 1 kg bag
  assert.equal(packsNeeded(q(250, 'g'), q(100, 'g')).packs, 3);
  assert.equal(packsNeeded(q(1010, 'g'), q(1, 'kg')).packs, 1); // 3% tolerance
  assert.equal(packsNeeded(q(15, 'tbsp'), q(500, 'ml')).packs, 1);
  assert.equal(packsNeeded(q(7, 'pcs'), q(6, 'pcs')).packs, 2);
  assert.equal(unitPrice(199, q(500, 'g')), 398);
});

test('tokenMatch distinguishes compounds that are the ingredient vs flavoured by it', () => {
  assert.equal(tokenMatch('kirschtomaten', 'tomaten'), 'head');
  assert.equal(tokenMatch('zitronenradler', 'zitrone'), 'modifier');
  assert.equal(tokenMatch('citroensap', 'citroen'), 'modifier');
  assert.equal(tokenMatch('pomidory', 'pomidor'), 'head');
  assert.equal(tokenMatch('яйца', 'яйцо'), 'head');
  assert.equal(tokenMatch('oliven', 'olivenol'), 'none');
  assert.equal(tokenMatch('zonnebloempit', 'zonnebloemolie'), 'none');
});

test('relevance rejects attribute / flavour / non-food matches', () => {
  const lemon = ['limon'];
  assert.ok(relevance('Limón', lemon, [], 'es') > 0.9);
  assert.ok(relevance('Mantecado de limón La Muralla', lemon, [], 'es') < 0.6);
  assert.ok(relevance('Landgraf Zitronenradler', ['zitronen'], [], 'de') < 0.6);
  assert.ok(relevance('Clever Sardinen in Sonnenblumenöl', ['sonnenblumenöl'], [], 'de') < 0.6);
  assert.equal(relevance('Jumbo Afwasmiddel Citroen 500 ml', ['citroen'], [], 'nl'), 0);
  assert.ok(relevance('Preparado de carne picada vacuno', ['carne picada de vacuno'], [], 'es') > 0.6);
  assert.ok(relevance("Олів'є", ['олія соняшникова'], [], 'uk') < 0.6);
});

// ── fake store for deterministic basket / planner tests ──
function fakeStore(catalog: Array<Omit<Offer, 'storeId' | 'currency' | 'source' | 'productId'> & { productId?: string }>): StoreConnector {
  const offers = catalog.map((o, i): Offer => ({ productId: o.productId ?? String(i), storeId: 'fake', currency: 'EUR', source: 'live', ...o }));
  return {
    info: { id: 'fake', name: 'Fake', chain: 'Fake', country: 'NL', currency: 'EUR', language: 'en', cart: 'list', source: 'live' },
    async search(query) {
      const words = query.toLowerCase().split(' ');
      return offers.filter((o) => words.every((w) => o.name.toLowerCase().includes(w.slice(0, -1))));
    },
  };
}

const store = fakeStore([
  { name: 'Carrots 1 kg', price: 99, pack: q(1, 'kg') },
  { name: 'Carrot cake', price: 250, pack: q(400, 'g') },
  { name: 'Onions 500 g', price: 79, pack: q(500, 'g') },
  { name: 'Eggs 6 pcs', price: 189, pack: q(6, 'pcs') },
  { name: 'Eggs 12 pcs', price: 329, pack: q(12, 'pcs') },
  { name: 'Rice 1 kg', price: 149, pack: q(1, 'kg') },
  { name: 'Chicken breast 500 g', price: 549, pack: q(500, 'g') },
  { name: 'Salmon 250 g', price: 699, pack: q(250, 'g') },
]);

test('matchIngredient picks the cheapest way to cover the need among relevant offers', async () => {
  const eggs = await matchIngredient({ name: 'eggs', qty: q(8, 'pcs') }, store, {});
  assert.equal(eggs.offer?.name, 'Eggs 12 pcs'); // 12-pack (3.29) beats 2x 6-pack (3.78)
  assert.equal(eggs.packs, 1);
  const carrots = await matchIngredient({ name: 'carrots', qty: q(2, 'pcs') }, store, {});
  assert.equal(carrots.offer?.name, 'Carrots 1 kg'); // not "Carrot cake" (excluded)
  const missing = await matchIngredient({ name: 'saffron', qty: q(1, 'g') }, store, {});
  assert.equal(missing.status, 'not_found');
});

test('aggregate merges the same ingredient across meals and units', () => {
  const list = aggregate([
    { ingredients: [{ name: 'carrot', qty: q(1, 'pcs') }, { name: 'rice', qty: q(90, 'g') }] },
    { ingredients: [{ name: 'Carrots', qty: q(140, 'g') }, { name: 'rice', qty: q(0.1, 'kg') }] },
  ]);
  const carrots = list.find((i) => i.name === 'carrots')!;
  assert.deepEqual(carrots.qty, { amount: 3, unit: 'pcs' }); // 1 pc + 140 g / 70 g
  assert.deepEqual(list.find((i) => i.name === 'rice')!.qty, { amount: 190, unit: 'g' });
});

test('quote + compare rank stores and count missing items', async () => {
  const list = [{ name: 'carrots', qty: q(2, 'pcs') }, { name: 'eggs', qty: q(2, 'pcs') }, { name: 'saffron', qty: q(1, 'g') }];
  const quote = await quoteBasket(list, store);
  assert.equal(quote.matched, 2);
  assert.equal(quote.missing, 1);
  assert.equal(quote.total, 99 + 189);
  const cmp = await compareStores(list, [store]);
  assert.equal(cmp.cheapest, 'fake');
});

const meal = (id: string, ingredients: Meal['ingredients'], tags: string[] = []): Meal => ({ id, title: id, servings: 1, tags, ingredients });

test('planner reuses shared packs and respects the budget', async () => {
  const meals = [
    meal('salmon', [{ name: 'salmon', qty: q(250, 'g') }]),
    meal('egg-rice', [{ name: 'eggs', qty: q(2, 'pcs') }, { name: 'rice', qty: q(90, 'g') }]),
    meal('chicken-rice', [{ name: 'chicken breast', qty: q(150, 'g') }, { name: 'rice', qty: q(90, 'g') }]),
    meal('carrot-rice', [{ name: 'carrots', qty: q(2, 'pcs') }, { name: 'rice', qty: q(90, 'g') }, { name: 'onion', qty: q(1, 'pcs') }]),
  ];
  const plan = await planWithinBudget({ meals, slots: ['Mon', 'Tue', 'Wed', 'Thu'], budget: 1200 }, store);
  assert.ok(plan.fits, `total ${plan.total} should fit 1200`);
  assert.ok(!plan.slots.some((s) => s.mealId === 'salmon'), 'expensive salmon should be avoided');
  // rice bought once (1 kg) even though 4 meals use it
  assert.equal(plan.lines.find((l) => l.ingredient.name === 'rice')?.packs, 1);
  assert.ok(plan.slots.every((s, _, all) => all.filter((x) => x.mealId === s.mealId).length <= 2), 'max 2 repeats');
});

test('cart handoff: provider choice and text export', async () => {
  assert.equal(bestProvider('US', 'list'), 'instacart');
  assert.equal(bestProvider('NL', 'deeplink'), process.env.PEPESTO_API_KEY ? 'pepesto-checkout' : 'pepesto-predirect');
  assert.equal(bestProvider('KZ', 'deeplink'), 'store-links');
  assert.equal(bestProvider('UA', 'list'), 'text');
  const quote = await quoteBasket([{ name: 'eggs', qty: q(2, 'pcs') }], store);
  const cart = await createCart(quote, 'text');
  assert.match(cart.text!, /Eggs 6 pcs/);
  assert.deepEqual(shoppingListLines(quote), ['2 pcs eggs']);
});

// ── contract tests for paid cart providers (no real keys: fetch is stubbed) ──
async function withFetchStub(responses: Record<string, unknown>, fn: (calls: Array<{ url: string; body: any; headers: any }>) => Promise<void>) {
  const calls: Array<{ url: string; body: any; headers: any }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined, headers: init?.headers });
    const key = Object.keys(responses).find((k) => String(url).endsWith(k))!;
    return new Response(JSON.stringify(responses[key]), { status: 200 });
  }) as typeof fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = real;
  }
}

test('instacart products_link request matches the documented schema', async () => {
  process.env.INSTACART_API_KEY = 'test-key';
  const quote = await quoteBasket([{ name: 'eggs', qty: q(2, 'pcs') }, { name: 'rice', qty: q(90, 'g') }], store);
  await withFetchStub({ '/idp/v1/products/products_link': { products_link_url: 'https://ic.example/list' } }, async (calls) => {
    const r = await createCart(quote, 'instacart', { title: 'Monday', linkback: 'myapp://shopping' });
    assert.equal(r.url, 'https://ic.example/list');
    const { url, body, headers } = calls[0];
    assert.equal(url, 'https://connect.dev.instacart.tools/idp/v1/products/products_link');
    assert.equal(headers.Authorization, 'Bearer test-key');
    assert.equal(body.title, 'Monday');
    assert.equal(body.link_type, 'shopping_list');
    assert.deepEqual(body.landing_page_configuration, { partner_linkback_url: 'myapp://shopping' });
    assert.deepEqual(body.line_items[0].line_item_measurements, [{ quantity: 2, unit: 'each' }]);
    assert.deepEqual(body.line_items[1].line_item_measurements, [{ quantity: 90, unit: 'gram' }]);
  });
  delete process.env.INSTACART_API_KEY;
});

test('pepesto checkout resolves SKUs then opens a white-label session', async () => {
  process.env.PEPESTO_API_KEY = 'pk';
  const quote = await quoteBasket([{ name: 'eggs', qty: q(2, 'pcs') }], store);
  await withFetchStub({
    '/api/products': { items: [{ item_name: 'eggs', products: [{ session_token: 'tok-1', num_units_to_buy: 1 }] }], not_indexed_items: [] },
    '/api/mcheckout': { session_id: 's1', mobile_hosted_url: 'https://pepesto.example/s1' },
  }, async (calls) => {
    const r = await createCart(quote, 'pepesto-checkout', { linkback: 'myapp://done' });
    assert.equal(r.url, 'https://pepesto.example/s1');
    assert.match(calls[0].body.manual_shopping_list, /eggs/);
    assert.deepEqual(calls[1].body.skus, [{ session_token: 'tok-1', num_units_to_buy: 1 }]);
    assert.equal(calls[1].body.redirect_url, 'myapp://done');
    assert.equal(calls[1].headers.Authorization, 'Bearer pk');
  });
  delete process.env.PEPESTO_API_KEY;
});
