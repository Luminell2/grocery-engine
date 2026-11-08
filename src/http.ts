// Tiny fetch wrapper: timeout, browser-like UA, retries on 429/5xx, in-memory TTL cache.

const UA =
  process.env.GROCERY_UA ??
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

export class HttpError extends Error {
  status: number;
  url: string;
  constructor(status: number, url: string, body: string) {
    super(`HTTP ${status} for ${url}: ${body.slice(0, 160)}`);
    this.status = status;
    this.url = url;
  }
}

interface Opts {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
  /** Cache successful responses for this many ms (GET and idempotent POST searches). */
  cacheMs?: number;
}

const cache = new Map<string, { at: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();
const hostSlots = new Map<string, { active: number; queue: Array<() => void> }>();
const MAX_PER_HOST = Number(process.env.GROCERY_MAX_PER_HOST ?? 4);
// Hosts with tighter per-IP rate limits.
const HOST_LIMITS: Record<string, number> = { 'consumer-api.wolt.com': 2, 'restaurant-api.wolt.com': 2 };

/** Max N concurrent requests per host: store APIs / WAFs answer bursts with 429 or resets. */
export async function withHostSlot<T>(host: string, max: number, fn: () => Promise<T>): Promise<T> {
  let s = hostSlots.get(host);
  if (!s) hostSlots.set(host, (s = { active: 0, queue: [] }));
  if (s.active >= max) await new Promise<void>((r) => s!.queue.push(r));
  s.active++;
  try {
    return await fn();
  } finally {
    s.active--;
    s.queue.shift()?.();
  }
}
const MAX_CACHE = 5000;

export async function fetchJson<T = any>(url: string, opts: Opts = {}): Promise<T> {
  const body = opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  const key = opts.cacheMs ? `${opts.method ?? 'GET'} ${url} ${body ?? ''} ${JSON.stringify(opts.headers ?? {})}` : '';
  if (key) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < opts.cacheMs!) return hit.value as T;
  }
  // Identical concurrent requests (same search from two baskets) share one network call.
  if (key && inflight.has(key)) return inflight.get(key) as Promise<T>;
  const host = new URL(url).host;
  const p = withHostSlot(host, HOST_LIMITS[host] ?? MAX_PER_HOST, () => doFetch<T>(url, body, key, opts));
  if (key) {
    inflight.set(key, p);
    p.finally(() => inflight.delete(key)).catch(() => {});
  }
  return p;
}

async function doFetch<T>(url: string, body: string | undefined, key: string, opts: Opts): Promise<T> {
  const retries = opts.retries ?? 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: opts.method ?? (body ? 'POST' : 'GET'),
        headers: {
          'User-Agent': UA,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...opts.headers,
        },
        body,
        redirect: 'follow',
        signal: AbortSignal.timeout(opts.timeoutMs ?? 12000),
      });
      const text = await res.text();
      if (!res.ok) {
        const err = new HttpError(res.status, url, text);
        if (res.status === 429 || res.status >= 500) {
          lastErr = err;
          if (attempt < retries) {
            const ra = Number(res.headers.get('retry-after'));
            await sleep(ra > 0 && ra < 30 ? ra * 1000 : 700 * 2 ** attempt); // 0.7s, 1.4s, 2.8s
          }
          continue;
        }
        throw err;
      }
      const value = JSON.parse(text) as T;
      if (key) {
        if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
        cache.set(key, { at: Date.now(), value });
      }
      return value;
    } catch (e) {
      lastErr = e;
      if (e instanceof HttpError && e.status < 500 && e.status !== 429) throw e;
      if (attempt < retries) await sleep(300 * (attempt + 1));
    }
  }
  throw lastErr;
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export const HOUR = 3600_000;
