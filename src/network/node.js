// iaADN - P2P Node: a real, minimal network transport between iaADN nodes
// Replaces the earlier no-op stubs (sendToPeer/broadcast used to do nothing
// — "In standalone mode, messages go nowhere"). See
// docs/PLAN_EVOLUCION.md Fase 4.
//
// Deliberately not libp2p/IOTAI-backed: a small swarm is a short, explicit
// list of peers (`network.peers` in config) sharing one pre-shared secret
// (`network.p2pSharedSecret` / IAADN_P2P_SECRET) — the same "private by
// default, explicit to expose" posture as the HTTP API (src/integration/api.js).
// With no shared secret configured, the P2P listener never starts at all —
// this node stays standalone, same as before. An outbound peer list is a
// separate, optional concern (who this node reaches out to); a node can
// listen with none configured, e.g. a seed others connect to first.

import { EventEmitter } from 'events';
import { createServer, request } from 'http';
import { PROTOCOLS, createMessage, parseMessage } from './protocols.js';
import { verifyToken } from '../integration/auth.js';

export class IaADNNode extends EventEmitter {
  constructor({ nodeId, identity, host = '127.0.0.1', port = 9090, peerAddresses = [], sharedSecret = null }) {
    super();
    this.nodeId = nodeId;
    this.identity = identity; // src/network/identity.js — signs outgoing genomes
    this.host = host;
    this.port = port;
    this.peerAddresses = peerAddresses; // configured [{ host, port }] — the swarm's fixed address book
    this.sharedSecret = sharedSecret;
    this.peers = new Map(); // "host:port" -> { lastSeen, nodeId, publicKey, ...gossiped stats }
    this.connected = false;
    this.messageHandlers = new Map();
    this.server = null;
  }

  // Start the P2P listener. No-ops into standalone mode if P2P isn't
  // configured — never binds a socket unless the operator opted in.
  async start() {
    this._registerHandlers();

    // The secret is what makes listening safe — bind whenever it's set,
    // even with no outbound peers configured yet (e.g. a seed node others
    // connect to first).
    if (!this.sharedSecret) {
      console.log('[P2PNode] No shared secret configured — running standalone (no P2P)');
      this.emit('started');
      return this;
    }

    this.server = createServer((req, res) => this._handleIncoming(req, res));
    await new Promise((resolveStart, rejectStart) => {
      this.server.once('error', rejectStart);
      this.server.listen(this.port, this.host, () => {
        console.log(`[P2PNode] Listening on http://${this.host}:${this.port} (${this.peerAddresses.length} peer(s) configured)`);
        resolveStart();
      });
    });

    this.connected = true;
    this.emit('started');
    return this;
  }

  // Register handler for a message type
  onMessage(type, handler) {
    this.messageHandlers.set(type, handler);
  }

  // Send a message to a specific peer, addressed as "host:port". A peer
  // that's down or unreachable just fails this send — best-effort, like any
  // gossip protocol; the next cycle tries again.
  async sendToPeer(peerAddr, protocol, message) {
    if (!this.connected) return { sent: false, reason: 'not_connected' };

    const [host, portStr] = peerAddr.split(':');
    const port = Number(portStr);
    const body = JSON.stringify({ protocol, message });

    return new Promise(resolveSend => {
      const req = request({
        host, port, path: '/p2p/message', method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${this.sharedSecret}`,
        },
        timeout: 5000,
      }, res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            resolveSend({ sent: false, reason: `http_${res.statusCode}` });
            return;
          }
          try {
            const parsed = JSON.parse(data);
            this.registerPeer(peerAddr, { nodeId: parsed.nodeId, publicKey: parsed.publicKey });
          } catch {
            // response wasn't JSON — still counts as delivered
          }
          resolveSend({ sent: true });
        });
      });
      req.on('error', () => resolveSend({ sent: false, reason: 'unreachable' }));
      req.on('timeout', () => { req.destroy(); resolveSend({ sent: false, reason: 'timeout' }); });
      req.write(body);
      req.end();
    });
  }

  // Broadcast a message to every configured peer address
  async broadcast(protocol, message) {
    const results = [];
    for (const { host, port } of this.peerAddresses) {
      const peerAddr = `${host}:${port}`;
      results.push({ peerId: peerAddr, ...(await this.sendToPeer(peerAddr, protocol, message)) });
    }
    return results;
  }

  // Handle an inbound P2P HTTP request
  _handleIncoming(req, res) {
    if (req.method !== 'POST' || req.url !== '/p2p/message') {
      res.writeHead(404);
      res.end();
      return;
    }
    if (!verifyToken(req.headers.authorization, this.sharedSecret)) {
      res.writeHead(401);
      res.end();
      return;
    }

    let body = '';
    let tooLarge = false;
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) { tooLarge = true; req.destroy(); }
    });
    req.on('end', () => {
      if (tooLarge) return;
      try {
        const { message } = JSON.parse(body);
        this.handleIncoming(message);
      } catch (err) {
        console.warn(`[P2PNode] Malformed message: ${err.message}`);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, nodeId: this.nodeId, publicKey: this.identity?.publicKeyBase64 || null }));
    });
  }

  // Handle incoming message
  handleIncoming(raw) {
    const message = parseMessage(raw);
    if (!message) return;

    const handler = this.messageHandlers.get(message.type);
    if (handler) {
      handler(message);
    }

    this.emit('message_received', message);
  }

  // Broadcast a genome to the network
  async broadcastGenome(genome) {
    const msg = createMessage('genome_broadcast', {
      instanceId: genome.instanceId,
      generation: genome.generation,
      hash: genome.hash(),
      specialization: genome.getSpecialization(),
    }, this.nodeId);

    return this.broadcast(PROTOCOLS.GENOME, msg);
  }

  // Broadcast fitness results
  async broadcastFitness(instanceId, fitnessResult) {
    const msg = createMessage('fitness_report', {
      instanceId,
      fitness: fitnessResult,
    }, this.nodeId);

    return this.broadcast(PROTOCOLS.FITNESS, msg);
  }

  // Offer compute resources to the network
  async offerCompute(capabilities) {
    const msg = createMessage('compute_offer', {
      nodeId: this.nodeId,
      capabilities,
      timestamp: Date.now(),
    }, this.nodeId);

    return this.broadcast(PROTOCOLS.COMPUTE, msg);
  }

  // Send a hive mind query to a peer
  async sendHiveQuery(peerId, subQuery) {
    const msg = createMessage('hive_query', subQuery, this.nodeId);
    return this.sendToPeer(peerId, PROTOCOLS.HIVE, msg);
  }

  // Register a peer (or refresh its known info)
  registerPeer(peerId, info = {}) {
    const existing = this.peers.get(peerId) || {};
    this.peers.set(peerId, {
      ...existing,
      ...info,
      lastSeen: Date.now(),
      capabilities: info.capabilities || existing.capabilities || {},
      population: info.population ?? existing.population ?? 0,
    });
    if (!existing.lastSeen) this.emit('peer_connected', peerId);
  }

  // Remove a peer
  removePeer(peerId) {
    this.peers.delete(peerId);
    this.emit('peer_disconnected', peerId);
  }

  // Get connected peers
  getPeers() {
    return Array.from(this.peers.entries()).map(([id, info]) => ({
      peerId: id,
      ...info,
    }));
  }

  // Get node status
  getStatus() {
    return {
      nodeId: this.nodeId,
      connected: this.connected,
      peerCount: this.peers.size,
      protocols: Object.values(PROTOCOLS),
    };
  }

  _registerHandlers() {
    // Default handler for gossip — refresh what we know about a peer we've
    // already registered (via a successful outbound send — see
    // sendToPeer). We can't reliably learn a peer's *listening* address
    // from an inbound connection alone, so this only enriches an existing
    // entry rather than creating new ones from an unfamiliar sender.
    this.onMessage('gossip_state', (msg) => {
      for (const [addr, info] of this.peers) {
        if (info.nodeId === msg.senderId) {
          this.registerPeer(addr, { ...info, ...msg.data });
          break;
        }
      }
    });
  }

  async stop() {
    this.connected = false;
    this.peers.clear();
    if (this.server) {
      await new Promise(resolveStop => this.server.close(resolveStop));
    }
    this.emit('stopped');
  }
}
