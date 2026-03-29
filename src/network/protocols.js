// iaADN - P2P Protocols: custom protocols for the iaADN network
// Runs on top of IOTAI's libp2p node

export const PROTOCOLS = {
  GENOME: '/iaADN/genome/1.0.0',       // Genome exchange
  FITNESS: '/iaADN/fitness/1.0.0',     // Fitness result sharing
  COMPUTE: '/iaADN/compute/1.0.0',     // Compute task distribution
  HIVE: '/iaADN/hive/1.0.0',          // Hive mind query routing
  EVOLUTION: '/iaADN/evolution/1.0.0', // Evolution event broadcasting
  GOSSIP: '/iaADN/gossip/1.0.0',      // Population state gossip
};

// Message types for each protocol
export const MESSAGE_TYPES = {
  // Genome protocol
  GENOME_REQUEST: 'genome_request',
  GENOME_RESPONSE: 'genome_response',
  GENOME_BROADCAST: 'genome_broadcast',

  // Fitness protocol
  FITNESS_REPORT: 'fitness_report',
  FITNESS_QUERY: 'fitness_query',

  // Compute protocol
  COMPUTE_OFFER: 'compute_offer',       // Node offers compute resources
  COMPUTE_REQUEST: 'compute_request',   // Request compute from network
  COMPUTE_ACCEPT: 'compute_accept',     // Accept a compute task
  COMPUTE_RESULT: 'compute_result',     // Return compute result
  COMPUTE_REJECT: 'compute_reject',     // Reject a compute task

  // Hive protocol
  HIVE_QUERY: 'hive_query',            // Sub-query from decomposer
  HIVE_RESPONSE: 'hive_response',      // Response to sub-query

  // Evolution protocol
  EVOLUTION_EVENT: 'evolution_event',   // New generation completed
  BIRTH_ANNOUNCEMENT: 'birth_announcement',
  DEATH_ANNOUNCEMENT: 'death_announcement',

  // Gossip protocol
  GOSSIP_STATE: 'gossip_state',        // Population state summary
  GOSSIP_REQUEST: 'gossip_request',    // Request state from peer
};

// Create a protocol message
export function createMessage(type, data, senderId) {
  return {
    type,
    data,
    senderId,
    timestamp: Date.now(),
    version: 1,
  };
}

// Parse a protocol message
export function parseMessage(raw) {
  try {
    if (typeof raw === 'string') return JSON.parse(raw);
    if (raw instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(raw));
    return raw;
  } catch {
    return null;
  }
}
