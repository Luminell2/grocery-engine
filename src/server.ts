// HTTP API for the mobile app's Shopping tab. Zero dependencies (node:http).
//   GET  /api/stores?country=NL                      -> supported stores
//   GET  /api/wolt/venues?lat=..&lon=..              -> grocery venues near the user (KZ, Baltics, Nordics, DE, PL...)
//   POST /api/wolt/register {slug,name,country,currency,language}
//   POST /api/list         {meals:[...]}                       -> aggregated shopping list for the selected day
//   POST /api/quote        {storeId, ingredients|meals, ctx}   -> priced basket at one store
//   POST /api/compare      {country|storeIds, ingredients|meals, ctx} -> stores ranked by total
//   POST /api/plan         {storeId, meals, slots, budget, ...} -> meals chosen to fit the budget
//   POST /api/cart         {storeId, ingredients|meals, provider?, ctx} -> order link / list
//   GET  /                 -> Shopping tab demo (web/index.html)

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { aggregate, compareStores, quoteBasket } from './basket.ts';
import { bestProvider, createCart, type CartProvider } from './cart.ts';
import { discoverWoltVenues } from './connectors/live.ts';
import { warmDatasets } from './connectors/datasets.ts';
import { warmOpenPrices } from './connectors/openprices.ts';
import { planWithinBudget } from './planner.ts';
import { getStore, listStores, registerWolt, storesFor } from './stores.ts';
import type { Ingredient, Meal } from './types.ts';

const WEB = join(import.meta.dirname, '..', 'web');

function ingredientsFrom(body: any): Ingredient[] {
  if (Array.isArray(body.ingredients)) return body.ingredients;
  if (Array.isArray(body.meals)) return aggregate(body.meals.map((m: Meal & { servingsFactor?: number }) => ({ ingredients: m.ingredients, servingsFactor: body.people ? body.people / (m.servings || 1) : m.servingsFactor })));
  throw Object.assign(new Error('Provide "ingredients" or "meals"'), { status: 400 });
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const s = Buffer.concat(chunks).toString('utf8');
  return s ? JSON.parse(s) : {};
}

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' });
  res.end(JSON.stringify(data));
}

const routes: Record<string, (body: any, url: URL) => Promise<unknown>> = {
  'GET /api/health': async () => ({ ok: true }),
  'GET /meals.json': async () => JSON.parse(await readFile(join(import.meta.dirname, '..', 'data', 'meals.json'), 'utf8')),
  'GET /api/stores': async (_b, url) => listStores(url.searchParams.get('country') ?? undefined),
  'GET /api/wolt/venues': async (_b, url) => discoverWoltVenues(Number(url.searchParams.get('lat')), Number(url.searchParams.get('lon'))),
  'POST /api/wolt/register': async (b) => registerWolt(b),
  'POST /api/list': async (b) => ingredientsFrom(b),
  'POST /api/quote': async (b) => quoteBasket(ingredientsFrom(b), getStore(b.storeId), b.ctx ?? {}),
  'POST /api/compare': async (b) => {
    const stores = b.storeIds ? b.storeIds.map(getStore) : storesFor(b.country ?? 'NL');
    return compareStores(ingredientsFrom(b), stores, b.ctx ?? {});
  },
  'POST /api/plan': async (b) => planWithinBudget(b, getStore(b.storeId), b.ctx ?? {}),
  'POST /api/cart': async (b) => {
    const store = getStore(b.storeId);
    const quote = b.quote ?? (await quoteBasket(ingredientsFrom(b), store, b.ctx ?? {}));
    const provider: CartProvider = b.provider ?? bestProvider(store.info.country, store.info.cart);
    return createCart(quote, provider, { title: b.title, locale: b.locale, linkback: b.linkback });
  },
};

export function startServer(port = Number(process.env.PORT ?? 8787)) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'OPTIONS') return send(res, 204, null);
    const route = routes[`${req.method} ${url.pathname}`];
    try {
      if (route) return send(res, 200, await route(req.method === 'POST' ? await readBody(req) : {}, url));
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        const file = join(WEB, url.pathname === '/' ? 'index.html' : url.pathname.replace(/\.\./g, ''));
        const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
        const data = await readFile(file);
        res.writeHead(200, { 'Content-Type': `${types[extname(file)] ?? 'application/octet-stream'}; charset=utf-8` });
        return res.end(data);
      }
      send(res, 404, { error: 'not found' });
    } catch (e: any) {
      send(res, e.status ?? (e.code === 'ENOENT' ? 404 : 500), { error: String(e.message ?? e) });
    }
  });
  server.listen(port, () => console.log(`grocery-engine on http://localhost:${port}`));
  warmDatasets().then(() => console.log('datasets warm'));
  warmOpenPrices().then(() => console.log('open prices warm'), (e) => console.warn('open prices unavailable:', e.message));
  return server;
}

if (import.meta.main) startServer();
