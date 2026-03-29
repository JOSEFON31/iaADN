// iaADN - REST API: external interface to communicate with the hive mind
// Provides chat, status, and population endpoints

import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname, extname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class API {
  constructor({ hiveMind, population, inferenceEngine, lineage, guardian, killSwitch, nodeId, port = 9091 }) {
    this.hiveMind = hiveMind;
    this.population = population;
    this.inferenceEngine = inferenceEngine;
    this.lineage = lineage;
    this.guardian = guardian;
    this.killSwitch = killSwitch;
    this.nodeId = nodeId;
    this.port = port;
    this.server = null;
  }

  start() {
    this.server = createServer((req, res) => this._handleRequest(req, res));
    this.server.listen(this.port, () => {
      console.log(`[API] Server running at http://localhost:${this.port}`);
      console.log(`[API] Chat UI: http://localhost:${this.port}/`);
    });
  }

  async _handleRequest(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://localhost:${this.port}`);
    const path = url.pathname;

    try {
      // --- API Routes ---
      if (path === '/api/chat' && req.method === 'POST') {
        return this._handleChat(req, res);
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
      if (path === '/api/health') {
        return this._json(res, { healthy: !this.killSwitch.isActive(), nodeId: this.nodeId });
      }

      // --- Static files (Chat UI) ---
      if (path === '/' || path === '/index.html') {
        return this._serveFile(res, resolve(__dirname, '../../docs/chat.html'), 'text/html');
      }

      // 404
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  async _handleChat(req, res) {
    const body = await this._readBody(req);
    const { message } = JSON.parse(body);

    if (!message) {
      return this._json(res, { error: 'Missing "message" field' }, 400);
    }

    // Route through hive mind
    if (this.hiveMind) {
      const result = await this.hiveMind.query(message);
      return this._json(res, {
        response: result.response,
        metadata: result.metadata,
      });
    }

    // Fallback: direct inference
    if (this.inferenceEngine?.ready) {
      const best = this.population?.getBest?.();
      const systemPrompt = best?.genome?.getSystemPrompt() || '';
      const result = await this.inferenceEngine.complete(
        [{ role: 'user', content: message }],
        { systemPrompt, maxTokens: 512 }
      );
      return this._json(res, {
        response: result.content,
        metadata: { mode: 'direct', model: result.model },
      });
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

  _json(res, data, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  _serveFile(res, filePath, contentType) {
    if (!existsSync(filePath)) {
      res.writeHead(404);
      res.end('File not found');
      return;
    }
    const content = readFileSync(filePath, 'utf-8');
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  }

  _readBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      console.log('[API] Server stopped');
    }
  }
}
