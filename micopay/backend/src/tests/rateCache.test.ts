import Fastify from 'fastify';
import { strictEqual, ok } from 'node:assert';
import { rateRoutes, __resetCache } from '../routes/rate.js';
import { AppError } from '../utils/errors.js';

const MOCK_RATE = 18.42;
const FUTURE_MS = 120_000; // advance past 60s TTL

function mockFetchOk(): void {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ stellar: { mxn: MOCK_RATE } }), { status: 200 });
}

function mockFetchFail(): void {
  globalThis.fetch = async () => new Response(null, { status: 429 });
}

function installErrorHandler(app: Fastify) {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      reply.status(error.httpStatus).send({
        code: error.code,
        message: error.userMessage,
      });
      return;
    }
    reply.status(500).send({ code: 'INTERNAL_ERROR', message: error.message });
  });
}

async function createApp() {
  const app = Fastify();
  installErrorHandler(app);
  await app.register(rateRoutes);
  await app.ready();
  return app;
}

async function testScenarios() {
  console.log('Running Rate Cache Tests...\n');

  // ── Scenario 1: CoinGecko fails, no cache → 503 ──
  console.log('1. CoinGecko unavailable, no cache → 503');
  __resetCache();
  mockFetchFail();
  const app1 = await createApp();
  const res1 = await app1.inject({ method: 'GET', url: '/rate/xlm-mxn' });
  strictEqual(res1.statusCode, 503);
  strictEqual(JSON.parse(res1.body).code, 'RATE_FETCH_FAILED');
  console.log('   ✓ 503 with RATE_FETCH_FAILED\n');
  await app1.close();

  // ── Scenario 2: Fresh fetch sets cache, then cache hit within TTL ──
  console.log('2. Fresh fetch followed by cache hit (TTL)');
  __resetCache();
  mockFetchOk();
  const app2 = await createApp();

  const req1 = await app2.inject({ method: 'GET', url: '/rate/xlm-mxn' });
  const body1 = JSON.parse(req1.body);
  strictEqual(req1.statusCode, 200);
  strictEqual(body1.rate, MOCK_RATE);
  strictEqual(body1.source, 'coingecko');
  ok(body1.fetchedAt);
  ok(!body1.stale);
  console.log('   ✓ First request: fresh data');

  mockFetchFail();
  const req2 = await app2.inject({ method: 'GET', url: '/rate/xlm-mxn' });
  const body2 = JSON.parse(req2.body);
  strictEqual(req2.statusCode, 200);
  strictEqual(body2.rate, MOCK_RATE);
  strictEqual(body2.fetchedAt, body1.fetchedAt, 'fetchedAt identical (cached)');
  strictEqual(body2.source, 'coingecko');
  ok(!body2.stale);
  console.log('   ✓ Second request: cached (no fetch called)\n');

  // ── Scenario 3: Cache expired, CoinGecko fails → stale fallback ──
  console.log('3. CoinGecko fails, expired cache → stale fallback');
  const origDateNow = Date.now;
  Date.now = () => origDateNow() + FUTURE_MS;

  const req3 = await app2.inject({ method: 'GET', url: '/rate/xlm-mxn' });
  Date.now = origDateNow;
  strictEqual(req3.statusCode, 200);
  const body3 = JSON.parse(req3.body);
  strictEqual(body3.rate, MOCK_RATE);
  strictEqual(body3.source, 'coingecko');
  strictEqual(body3.stale, true);
  ok(body3.fetchedAt);
  console.log('   ✓ 200 with stale:true\n');
  await app2.close();

  // ── Scenario 4: Response shape — fresh ──
  console.log('4. Response shape — fresh data');
  __resetCache();
  mockFetchOk();
  const app4 = await createApp();
  const res4 = await app4.inject({ method: 'GET', url: '/rate/xlm-mxn' });
  const body4 = JSON.parse(res4.body);
  strictEqual(Object.keys(body4).length, 3);
  ok('rate' in body4);
  ok('source' in body4);
  ok('fetchedAt' in body4);
  strictEqual(body4.source, 'coingecko');
  console.log('   ✓ Fresh: { rate, source, fetchedAt }\n');
  await app4.close();

  // ── Scenario 5: Response shape — stale ──
  console.log('5. Response shape — stale data');
  __resetCache();
  mockFetchOk();
  const app5 = await createApp();
  await app5.inject({ method: 'GET', url: '/rate/xlm-mxn' }); // prime cache
  mockFetchFail();
  Date.now = () => origDateNow() + FUTURE_MS; // expire cache
  const res5 = await app5.inject({ method: 'GET', url: '/rate/xlm-mxn' });
  Date.now = origDateNow;
  const body5 = JSON.parse(res5.body);
  strictEqual(Object.keys(body5).length, 4);
  strictEqual(body5.stale, true);
  strictEqual(body5.rate, MOCK_RATE);
  strictEqual(body5.source, 'coingecko');
  ok(body5.fetchedAt);
  console.log('   ✓ Stale: { rate, source, fetchedAt, stale }\n');
  await app5.close();

  console.log('✅ All Rate Cache Tests Passed!');
}

testScenarios().catch(err => {
  console.error('Tests failed:', err);
  process.exit(1);
});
