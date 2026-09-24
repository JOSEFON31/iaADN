// iaADN - API security tests
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'http';
import { API } from '../src/integration/api.js';
import { verifyToken, RateLimiter } from '../src/integration/auth.js';
import { InferenceEngine } from '../src/inference/engine.js';
import { MockBackend } from '../src/inference/mock-backend.js';
import { Genome } from '../src/genome/genome.js';
import { Lineage } from '../src/genome/lineage.js';

const TOKEN = 'test-token-0123456789';

// Minimal stand-ins for the parts of the system the API reads from
function fakeDeps() {
  const genome = Genome.createGenesis('test-node');
  const instance = { genome, fitness: 0.6, alive: true };
  return {
    population: {
      getBest: () => instance,
      getLiving: () => [instance],
      getStats: () => ({ populationSize: 1 }),
    },
    lineage: new Lineage(),
    guardian: { getResourceStatus: () => ({ cpuCores: 1 }) },
    killSwitch: { isActive: () => false, getStatus: () => ({ activated: false }) },
    nodeId: 'node_test',
  };
}

async function startApi(overrides = {}) {
  const engine = new InferenceEngine(new MockBackend());
  await engine.initialize();
  const api = new API({
    ...fakeDeps(),
    inferenceEngine: engine,
    port: 0,
    host: '127.0.0.1',
    token: TOKEN,
    maxBodyBytes: 1024,
    maxMessageChars: 100,
    rateLimit: { windowMs: 60000, max: 1000 },
    ...overrides,
  });
  await api.start();
  return api;
}

// Raw HTTP call so we can set any header and body we want
function call(api, { method = 'GET', path = '/', headers = {}, body = null } = {}) {
  return new Promise((resolveCall, rejectCall) => {
    const req = request(
      { host: '127.0.0.1', port: api.port, method, path, headers },
      res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch {}
          resolveCall({ status: res.statusCode, headers: res.headers, text: data, json });
        });
      }
    );
    req.on('error', rejectCall);
    if (body != null) req.write(body);
    req.end();
  });
}

const auth = { Authorization: `Bearer ${TOKEN}` };

describe('verifyToken', () => {
  it('accepts the right bearer token only', () => {
    assert.equal(verifyToken(`Bearer ${TOKEN}`, TOKEN), true);
    assert.equal(verifyToken(`bearer ${TOKEN}`, TOKEN), true);
    assert.equal(verifyToken('Bearer wrong', TOKEN), false);
    assert.equal(verifyToken(TOKEN, TOKEN), false, 'missing Bearer scheme');
    assert.equal(verifyToken(undefined, TOKEN), false);
    assert.equal(verifyToken(`Bearer ${TOKEN}`, null), false, 'no configured token never matches');
  });
});

describe('RateLimiter', () => {
  it('blocks after max requests in a window and resets afterwards', () => {
    const limiter = new RateLimiter({ windowMs: 1000, max: 2 });
    assert.equal(limiter.check('1.1.1.1', 0).allowed, true);
    assert.equal(limiter.check('1.1.1.1', 10).allowed, true);
    const blocked = limiter.check('1.1.1.1', 20);
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterSec >= 1);
    assert.equal(limiter.check('2.2.2.2', 20).allowed, true, 'other IPs are independent');
    assert.equal(limiter.check('1.1.1.1', 1001).allowed, true, 'new window');
  });
});

describe('API', () => {
  let api;
  before(async () => { api = await startApi(); });
  after(() => api.stop());

  it('refuses to start without a token', async () => {
    const noToken = new API({ ...fakeDeps(), port: 0, token: null });
    assert.throws(() => noToken.start(), /token is required/);
  });

  it('listens on the configured host', () => {
    assert.equal(api.server.address().address, '127.0.0.1');
  });

  it('requires the token on private endpoints', async () => {
    for (const path of ['/api/status', '/api/population', '/api/lineage']) {
      assert.equal((await call(api, { path })).status, 401, `${path} without token`);
      assert.equal((await call(api, { path, headers: { Authorization: 'Bearer nope' } })).status, 401, `${path} bad token`);
      assert.equal((await call(api, { path, headers: auth })).status, 200, `${path} good token`);
    }
  });

  it('serves health and the chat page without a token, without leaking the node id', async () => {
    const health = await call(api, { path: '/api/health' });
    assert.equal(health.status, 200);
    assert.deepEqual(health.json, { healthy: true });

    const page = await call(api, { path: '/' });
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /text\/html/);
  });

  it('returns an empty generations list when no persistence store is configured', async () => {
    const res = await call(api, { path: '/api/generations', headers: auth });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { generations: [] });
  });

  it('reads generations from the persistence store, respecting the limit param', async () => {
    const rows = [{ generation: 1, avgFitness: 0.4 }, { generation: 2, avgFitness: 0.5 }];
    const withPersistence = await startApi({
      persistence: { listGenerations: (limit) => rows.slice(0, limit) },
    });
    try {
      const res = await call(withPersistence, { path: '/api/generations?limit=1', headers: auth });
      assert.equal(res.status, 200);
      assert.deepEqual(res.json.generations, [rows[0]]);
    } finally {
      withPersistence.stop();
    }
  });

  it('answers chat with a valid token', async () => {
    const res = await call(api, {
      method: 'POST', path: '/api/chat', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'What is 15 + 27?' }),
    });
    assert.equal(res.status, 200);
    assert.equal(typeof res.json.response, 'string');
  });

  it('rejects chat without a token before reading the body', async () => {
    const res = await call(api, { method: 'POST', path: '/api/chat', body: JSON.stringify({ message: 'hi' }) });
    assert.equal(res.status, 401);
  });

  it('returns 400 for invalid JSON, a missing message, or a too-long message', async () => {
    const post = body => call(api, { method: 'POST', path: '/api/chat', headers: auth, body });
    assert.equal((await post('{not json')).status, 400);
    assert.equal((await post(JSON.stringify({}))).status, 400);
    assert.equal((await post(JSON.stringify({ message: 'x'.repeat(101) }))).status, 400);
  });

  it('returns 413 for bodies over the limit, with or without Content-Length', async () => {
    const big = JSON.stringify({ message: 'x'.repeat(5000) });
    const declared = await call(api, { method: 'POST', path: '/api/chat', headers: auth, body: big });
    assert.equal(declared.status, 413);

    const chunked = await call(api, {
      method: 'POST', path: '/api/chat', headers: { ...auth, 'Transfer-Encoding': 'chunked' }, body: big,
    });
    assert.equal(chunked.status, 413);
  });

  it('sends security headers and no wildcard CORS', async () => {
    const res = await call(api, { path: '/api/health', headers: { Origin: 'https://evil.example' } });
    assert.equal(res.headers['access-control-allow-origin'], undefined);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-frame-options'], 'DENY');
  });

  it('does not leak internal error messages', async () => {
    const broken = await startApi({
      guardian: { getResourceStatus: () => { throw new Error('secret internal detail'); } },
    });
    try {
      const res = await call(broken, { path: '/api/status', headers: auth });
      assert.equal(res.status, 500);
      assert.deepEqual(res.json, { error: 'Internal error' });
    } finally {
      broken.stop();
    }
  });
});

describe('API with allowed origins and rate limit', () => {
  it('echoes CORS only for allowed origins', async () => {
    const api = await startApi({ allowedOrigins: ['https://ok.example'] });
    try {
      const ok = await call(api, { path: '/api/health', headers: { Origin: 'https://ok.example' } });
      assert.equal(ok.headers['access-control-allow-origin'], 'https://ok.example');
      const bad = await call(api, { path: '/api/health', headers: { Origin: 'https://evil.example' } });
      assert.equal(bad.headers['access-control-allow-origin'], undefined);
    } finally {
      api.stop();
    }
  });

  it('returns 429 with Retry-After once the limit is hit', async () => {
    const api = await startApi({ rateLimit: { windowMs: 60000, max: 3 } });
    try {
      for (let i = 0; i < 3; i++) {
        assert.equal((await call(api, { path: '/api/status', headers: auth })).status, 200);
      }
      const limited = await call(api, { path: '/api/status', headers: auth });
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers['retry-after']) >= 1);
    } finally {
      api.stop();
    }
  });

  it('only trusts X-Forwarded-For when trustProxy is enabled', async () => {
    const direct = await startApi({ rateLimit: { windowMs: 60000, max: 1 } });
    try {
      // Spoofed header must not give each request a fresh bucket
      await call(direct, { path: '/api/health', headers: { 'X-Forwarded-For': '9.9.9.1' } });
      const second = await call(direct, { path: '/api/health', headers: { 'X-Forwarded-For': '9.9.9.2' } });
      assert.equal(second.status, 429);
    } finally {
      direct.stop();
    }

    const proxied = await startApi({ rateLimit: { windowMs: 60000, max: 1 }, trustProxy: true });
    try {
      await call(proxied, { path: '/api/health', headers: { 'X-Forwarded-For': '9.9.9.1' } });
      const other = await call(proxied, { path: '/api/health', headers: { 'X-Forwarded-For': '9.9.9.2' } });
      assert.equal(other.status, 200);
    } finally {
      proxied.stop();
    }
  });
});
