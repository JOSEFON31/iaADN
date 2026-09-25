// iaADN - REST API: external interface to communicate with the hive mind
// Provides chat, status, and population endpoints
// Private by default: local-only listener, bearer token on /api/*, per-IP
// rate limit, body size limit, no wildcard CORS. See docs/PLAN_EVOLUCION.md §4.

import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { verifyToken, RateLimiter } from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Endpoints reachable without a token (still rate limited)
const PUBLIC_API_PATHS = new Set(['/api/health']);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function normalizeForMatch(text) {
  return String(text).trim().toLowerCase();
}

export class API {
  constructor({
    hiveMind,
    population,
    inferenceEngine,
    lineage,
    guardian,
    killSwitch,
    persistence = null,
    p2pNode = null,
    nodeId,
    port = 9091,
    host = '127.0.0.1',
    token = null,
    allowedOrigins = [],
    rateLimit = { windowMs: 60 * 1000, max: 30 },
    maxBodyBytes = 16 * 1024,
    maxMessageChars = 4000,
    trustProxy = false,
  }) {
    this.hiveMind = hiveMind;
    this.population = population;
    this.inferenceEngine = inferenceEngine;
    this.lineage = lineage;
    this.guardian = guardian;
    this.killSwitch = killSwitch;
    this.persistence = persistence;
    this.p2pNode = p2pNode;
    this.nodeId = nodeId;
    this.port = port;
    this.host = host;
    this.token = token;
    this.allowedOrigins = new Set(allowedOrigins);
    this.rateLimiter = new RateLimiter(rateLimit);
    this.maxBodyBytes = maxBodyBytes;
    this.maxMessageChars = maxMessageChars;
    this.trustProxy = trustProxy;
    this.server = null;
  }

  // Resolves with the port actually bound (useful with port 0 in tests)
  start() {
    if (!this.token) {
      throw new Error('API token is required — refusing to start an unauthenticated API');
    }
    this.server = createServer((req, res) => this._handleRequest(req, res));
    return new Promise((resolveStart, rejectStart) => {
      this.server.once('error', rejectStart);
      this.server.listen(this.port, this.host, () => {
        this.port = this.server.address().port;
        console.log(`[API] Listening on http://${this.host}:${this.port}`);
        resolveStart(this.port);
      });
    });
  }

  async _handleRequest(req, res) {
    this._setBaseHeaders(req, res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    try {
      if (path.startsWith('/api/')) {
        const limit = this.rateLimiter.check(this._clientIp(req));
        if (!limit.allowed) {
          res.setHeader('Retry-After', String(limit.retryAfterSec));
          return this._json(res, { error: 'Too many requests' }, 429);
        }

        if (!PUBLIC_API_PATHS.has(path) && !verifyToken(req.headers.authorization, this.token)) {
          res.setHeader('WWW-Authenticate', 'Bearer');
          return this._json(res, { error: 'Unauthorized' }, 401);
        }
      }

      // --- API Routes ---
      if (path === '/api/chat' && req.method === 'POST') {
        return await this._handleChat(req, res);
      }
      if (path === '/api/status') {
        return this._handleStatus(res);
      }
      if (path === '/api/population') {
        return this._handlePopulation(res);
      }
      if (path === '/api/lineage') {
        return this._handleLineage(res);
      }
      if (path === '/api/generations') {
        return this._handleGenerations(res, url.searchParams);
      }
      if (path === '/api/peers') {
        return this._handlePeers(res);
      }
      const rateMatch = path.match(/^\/api\/interactions\/(\d+)\/rate$/);
      if (rateMatch && req.method === 'POST') {
        return await this._handleRate(req, res, Number(rateMatch[1]));
      }
      if (path === '/api/health') {
        return this._json(res, { healthy: !this.killSwitch.isActive() });
      }

      // --- Static files (Chat UI) — no secrets in it, served without a token ---
      if (path === '/' || path === '/index.html') {
        return this._serveFile(res, resolve(__dirname, '../../docs/chat.html'), 'text/html; charset=utf-8');
      }

      return this._json(res, { error: 'Not found' }, 404);
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.status === 413) res.setHeader('Connection', 'close');
        return this._json(res, { error: err.message }, err.status);
      }
      console.error(`[API] ${req.method} ${path} failed: ${err.stack || err.message}`);
      return this._json(res, { error: 'Internal error' }, 500);
    }
  }

  _setBaseHeaders(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');

    // CORS only for explicitly allowed origins — never a wildcard
    const origin = req.headers.origin;
    if (origin && this.allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
  }

  // Behind a reverse proxy every request comes from 127.0.0.1, so the proxy's
  // X-Forwarded-For is used — but only when trustProxy is set, since clients
  // can forge that header when talking to the API directly.
  _clientIp(req) {
    if (this.trustProxy) {
      const forwarded = req.headers['x-forwarded-for'];
      if (typeof forwarded === 'string' && forwarded.length > 0) {
        return forwarded.split(',')[0].trim();
      }
    }
    return req.socket.remoteAddress || 'unknown';
  }

  async _handleChat(req, res) {
    const body = await this._readBody(req);

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new HttpError(400, 'Invalid JSON body');
    }

    const message = parsed?.message;
    if (typeof message !== 'string' || message.trim().length === 0) {
      return this._json(res, { error: 'Missing "message" field' }, 400);
    }
    if (message.length > this.maxMessageChars) {
      return this._json(res, { error: `Message too long (max ${this.maxMessageChars} characters)` }, 400);
    }

    // Recall: if this is (near enough) a question already asked and rated
    // 👍, answer straight from memory instead of calling the model again —
    // real reuse of what was learned, not just storage nobody reads. See
    // docs/PLAN_EVOLUCION.md Fase 3.
    const memoryMatch = this.persistence?.searchMemory(message, 1)?.[0];
    if (memoryMatch && normalizeForMatch(memoryMatch.query) === normalizeForMatch(message)) {
      return this._json(res, {
        response: memoryMatch.response,
        metadata: { mode: 'memory', interactionId: memoryMatch.interactionId },
      });
    }

    // Direct inference — fast path, single inference call
    // (HiveMind decompose+distribute is too slow on low-end hardware for interactive chat)
    if (this.inferenceEngine?.ready) {
      const best = this.population?.getBest?.();
      const systemPrompt = best?.genome?.getSystemPrompt() || '';
      const config = best?.genome?.getInferenceConfig() || {};

      let timer;
      try {
        // Use dedicated chat context — never blocked by daemon fitness evaluation
        const result = await Promise.race([
          this.inferenceEngine.chatComplete(
            [{ role: 'user', content: message }],
            {
              systemPrompt,
              temperature: config.temperature || 0.7,
              maxTokens: 256,
            }
          ),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Inference timeout (120s)')), 120000);
          }),
        ]);

        const interactionId = this.persistence?.recordInteraction({
          query: message,
          response: result.content,
          instanceId: best?.genome?.instanceId || null,
          source: 'chat',
        }) ?? null;

        return this._json(res, {
          response: result.content,
          metadata: {
            mode: 'direct',
            model: result.model,
            instanceId: best?.genome?.instanceId || null,
            fitness: best?.fitness || null,
            interactionId,
          },
        });
      } catch (err) {
        console.error(`[API] Chat inference failed: ${err.message}`);
        return this._json(res, {
          response: '[iaADN] Error: inference failed',
          metadata: { mode: 'error' },
        });
      } finally {
        clearTimeout(timer);
      }
    }

    return this._json(res, {
      response: '[iaADN] Inference engine not available. Load a GGUF model into data/models/',
      metadata: { mode: 'offline' },
    });
  }

  _handleStatus(res) {
    const living = this.population?.getLiving?.() || [];
    return this._json(res, {
      nodeId: this.nodeId,
      population: living.length,
      instances: living.map(inst => ({
        id: inst.genome.instanceId,
        generation: inst.genome.generation,
        fitness: inst.fitness,
        specialization: inst.genome.getSpecialization(),
      })),
      resources: this.guardian.getResourceStatus(),
      inferenceReady: this.inferenceEngine?.ready || false,
      killSwitch: this.killSwitch.getStatus(),
    });
  }

  _handlePopulation(res) {
    const stats = this.population?.getStats?.() || {};
    const living = this.population?.getLiving?.() || [];
    return this._json(res, {
      stats,
      instances: living.map(inst => ({
        id: inst.genome.instanceId,
        generation: inst.genome.generation,
        fitness: inst.fitness,
        hash: inst.genome.hash(),
        geneCount: inst.genome.geneCount,
        specialization: inst.genome.getSpecialization(),
        traits: inst.genome.getGene('traits')?.value,
        temperature: inst.genome.getGene('temperature')?.value,
      })),
    });
  }

  _handleLineage(res) {
    return this._json(res, {
      stats: this.lineage.getStats(),
      tree: this.lineage.toJSON().slice(-50), // last 50 entries
    });
  }

  // Fitness-over-time — reads generations already recorded by
  // PersistenceStore (src/evolution/population.js writes one row per
  // generation), so this adds no new storage. See docs/PLAN_EVOLUCION.md
  // Fase 2 — "lineage dashboard".
  _handleGenerations(res, searchParams) {
    if (!this.persistence) {
      return this._json(res, { generations: [] });
    }
    const limit = Math.min(500, Math.max(1, parseInt(searchParams.get('limit'), 10) || 100));
    return this._json(res, { generations: this.persistence.listGenerations(limit) });
  }

  // P2P swarm visibility (Fase 4) — never returns nodeId private keys, just
  // the public status src/network/node.js already tracks.
  _handlePeers(res) {
    if (!this.p2pNode) {
      return this._json(res, { connected: false, peers: [] });
    }
    return this._json(res, {
      connected: this.p2pNode.connected,
      nodeId: this.p2pNode.nodeId,
      peers: this.p2pNode.getPeers(),
    });
  }

  // 👍/👎 on a chat reply — see docs/PLAN_EVOLUCION.md Fase 3. A positive
  // rating makes the exchange searchable via PersistenceStore.searchMemory;
  // a negative one removes it if it was there.
  async _handleRate(req, res, id) {
    if (!this.persistence) {
      return this._json(res, { error: 'Not available' }, 404);
    }

    const body = await this._readBody(req);
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new HttpError(400, 'Invalid JSON body');
    }

    const rating = parsed?.rating;
    if (rating !== 1 && rating !== -1) {
      return this._json(res, { error: 'rating must be 1 or -1' }, 400);
    }

    const found = this.persistence.rateInteraction(id, rating);
    if (!found) {
      return this._json(res, { error: 'Interaction not found' }, 404);
    }
    return this._json(res, { id, rating });
  }

  _json(res, data, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  _serveFile(res, filePath, contentType) {
    if (!existsSync(filePath)) {
      return this._json(res, { error: 'Not found' }, 404);
    }
    const content = readFileSync(filePath, 'utf-8');
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  }

  // Read the request body, rejecting with 413 once it passes maxBodyBytes.
  // Excess data is drained, not buffered, so a huge upload can't fill RAM.
  _readBody(req) {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > this.maxBodyBytes) {
      req.resume();
      return Promise.reject(new HttpError(413, 'Request body too large'));
    }

    return new Promise((resolveBody, rejectBody) => {
      const chunks = [];
      let size = 0;
      let tooLarge = false;

      req.on('data', chunk => {
        if (tooLarge) return;
        size += chunk.length;
        if (size > this.maxBodyBytes) {
          tooLarge = true;
          chunks.length = 0;
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (tooLarge) rejectBody(new HttpError(413, 'Request body too large'));
        else resolveBody(Buffer.concat(chunks).toString('utf-8'));
      });
      req.on('error', rejectBody);
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server.closeAllConnections?.();
      console.log('[API] Server stopped');
    }
  }
}
