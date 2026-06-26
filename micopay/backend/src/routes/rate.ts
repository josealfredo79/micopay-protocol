import type { FastifyInstance } from 'fastify';
import { UpstreamError } from '../utils/errors.js';

const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=mxn';
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  rate: number;
  source: string;
  fetchedAt: string;
}

let cache: CacheEntry | null = null;

/** @internal — exposed for testing */
export function __resetCache(): void {
  cache = null;
}

async function fetchRateFromCoinGecko(): Promise<CacheEntry> {
  const res = await fetch(COINGECKO_URL, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) {
    throw new UpstreamError(
      'RATE_FETCH_FAILED',
      'No se pudo obtener la tasa de cambio en este momento.',
      `CoinGecko responded ${res.status}`,
      503,
    );
  }
  const data = (await res.json()) as { stellar?: { mxn?: number } };
  const rate = data?.stellar?.mxn;
  if (typeof rate !== 'number' || rate <= 0) {
    throw new UpstreamError(
      'RATE_FETCH_FAILED',
      'No se pudo obtener la tasa de cambio en este momento.',
      `Unexpected CoinGecko payload: ${JSON.stringify(data)}`,
      503,
    );
  }
  return { rate, source: 'coingecko', fetchedAt: new Date().toISOString() };
}

export async function rateRoutes(app: FastifyInstance) {
  app.get('/rate/xlm-mxn', async (_request, _reply) => {
    const now = Date.now();

    if (cache && now - new Date(cache.fetchedAt).getTime() < CACHE_TTL_MS) {
      return cache;
    }

    try {
      const fresh = await fetchRateFromCoinGecko();
      cache = fresh;
      return fresh;
    } catch (err) {
      if (cache) {
        return { ...cache, stale: true };
      }
      throw err;
    }
  });
}
