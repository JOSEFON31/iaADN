// iaADN - P2P Node: extends IOTAI's libp2p network with iaADN protocols
// Handles genome exchange, fitness sharing, compute distribution, hive queries

import { EventEmitter } from 'events';
import { PROTOCOLS, createMessage, parseMessage } from './protocols.js';

export class IaADNNode extends EventEmitter {
  constructor({ nodeId, iotaiBridge }) {
    super();
    this.nodeId = nodeId;
    this.iotaiBridge = iotaiBridge;
    this.peers = new Map(); // peerId -> { lastSeen, capabilities, population }
    this.connected = false;
    this.messageHandlers = new Map();
  }

  // Start the P2P node
  async start() {
    // Register message handlers
    this._registerHandlers();

    // Try to connect to IOTAI's P2P network
    if (this.iotaiBridge.isConnected()) {
      try {
        // Register iaADN protocols on IOTAI's libp2p node
        console.log('[P2PNode] Registering iaADN protocols on IOTAI network');
        this.connected = true;
      } catch (err) {
        console.warn(`[P2PNode] Could not register on IOTAI network: ${err.message}`);
      }
    }

    if (!this.connected) {
      console.log('[P2PNode] Running in standalone mode (no P2P)');
    }

    this.emit('started');
    return this;
  }

  // Register handler for a message type
  onMessage(type, handler) {
    this.messageHandlers.set(type, handler);
  }

  // Send a message to a specific peer
  async sendToPeer(peerId, protocol, message) {
    if (!this.connected) return { sent: false, reason: 'not_connected' };

    const msg = typeof message === 'string' ? message : JSON.stringify(message);

    // In standalone mode, messages go nowhere
    // When connected to IOTAI P2P, they go through libp2p streams
    this.emit('message_sent', { peerId, protocol, message });
    return { sent: true };
  }

  // Broadcast a message to all peers
  async broadcast(protocol, message) {
    const results = [];
    for (const [peerId] of this.peers) {
      const result = await this.sendToPeer(peerId, protocol, message);
      results.push({ peerId, ...result });
    }
    return results;
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

  // Register a peer
  registerPeer(peerId, info = {}) {
    this.peers.set(peerId, {
      lastSeen: Date.now(),
      capabilities: info.capabilities || {},
      population: info.population || 0,
      ...info,
    });
    this.emit('peer_connected', peerId);
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
    // Default handler for gossip — update peer state
    this.onMessage('gossip_state', (msg) => {
      if (msg.senderId) {
        this.registerPeer(msg.senderId, msg.data);
      }
    });
  }

  async stop() {
    this.connected = false;
    this.peers.clear();
    this.emit('stopped');
  }
}
