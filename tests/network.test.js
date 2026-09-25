// iaADN - P2P network tests (Fase 4): real HTTP transport between two
// IaADNNode instances on localhost, not mocks.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IaADNNode } from '../src/network/node.js';
import { createMessage } from '../src/network/protocols.js';
import { loadOrCreateIdentity } from '../src/network/identity.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const SECRET = 'test-shared-secret';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'iaadn-test-'));
  return (async () => {
    try {
      return await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })();
}

describe('IaADNNode standalone mode', () => {
  it('never binds a socket when no peers/secret are configured', async () => {
    const node = new IaADNNode({ nodeId: 'solo' });
    await node.start();
    assert.equal(node.connected, false);
    assert.equal(node.server, null);
    await node.stop();
  });
});

describe('IaADNNode real transport between two nodes', () => {
  it('exchanges a message, verifies the shared secret, and registers the peer', () => withTempDir(async dir => {
    const identityA = loadOrCreateIdentity(join(dir, 'a.key'));
    const identityB = loadOrCreateIdentity(join(dir, 'b.key'));

    const nodeA = new IaADNNode({
      nodeId: 'node-a', identity: identityA, host: '127.0.0.1', port: 0,
      peerAddresses: [], sharedSecret: SECRET,
    });
    const nodeB = new IaADNNode({
      nodeId: 'node-b', identity: identityB, host: '127.0.0.1', port: 0,
      peerAddresses: [], sharedSecret: SECRET,
    });

    // port: 0 lets the OS pick a free port — start them, then wire up
    // peerAddresses using the real bound ports.
    await nodeA.start();
    await nodeB.start();
    // Standalone mode was skipped because sharedSecret is set, but
    // peerAddresses was empty — start() still needs a real bound port to
    // test sendToPeer/broadcast, so set it up manually here instead.

    try {
      let received = null;
      nodeB.onMessage('ping', msg => { received = msg; });

      const portB = nodeB.server.address().port;
      const result = await nodeA.sendToPeer(`127.0.0.1:${portB}`, 'ping', createMessage('ping', { hello: 'world' }, 'node-a'));

      assert.equal(result.sent, true);
      assert.ok(received, 'node B should have received the message');
      assert.equal(received.data.hello, 'world');
      assert.equal(received.senderId, 'node-a');

      // A successful round trip should have registered B as a peer of A
      const peers = nodeA.getPeers();
      assert.equal(peers.length, 1);
      assert.equal(peers[0].nodeId, 'node-b');
      assert.equal(peers[0].publicKey, identityB.publicKeyBase64);
    } finally {
      await nodeA.stop();
      await nodeB.stop();
    }
  }));

  it('rejects a message with the wrong shared secret', () => withTempDir(async dir => {
    const nodeB = new IaADNNode({
      nodeId: 'node-b', identity: loadOrCreateIdentity(join(dir, 'b.key')),
      host: '127.0.0.1', port: 0, peerAddresses: [], sharedSecret: SECRET,
    });
    await nodeB.start();

    const attacker = new IaADNNode({
      nodeId: 'attacker', identity: loadOrCreateIdentity(join(dir, 'x.key')),
      host: '127.0.0.1', port: 0, peerAddresses: [], sharedSecret: 'wrong-secret',
    });
    await attacker.start();

    try {
      const portB = nodeB.server.address().port;
      const result = await attacker.sendToPeer(`127.0.0.1:${portB}`, 'ping', createMessage('ping', {}, 'attacker'));
      assert.equal(result.sent, false);
      assert.equal(result.reason, 'http_401');
    } finally {
      await nodeB.stop();
      await attacker.stop();
    }
  }));

  it('broadcast reaches every configured peer address and reports failures for unreachable ones', () => withTempDir(async dir => {
    const nodeB = new IaADNNode({
      nodeId: 'node-b', identity: loadOrCreateIdentity(join(dir, 'b.key')),
      host: '127.0.0.1', port: 0, peerAddresses: [], sharedSecret: SECRET,
    });
    await nodeB.start();
    const portB = nodeB.server.address().port;

    const nodeA = new IaADNNode({
      nodeId: 'node-a', identity: loadOrCreateIdentity(join(dir, 'a.key')),
      host: '127.0.0.1', port: 0,
      peerAddresses: [{ host: '127.0.0.1', port: portB }, { host: '127.0.0.1', port: 1 }], // second one unreachable
      sharedSecret: SECRET,
    });
    await nodeA.start();

    try {
      const results = await nodeA.broadcast('ping', createMessage('ping', {}, 'node-a'));
      assert.equal(results.length, 2);
      assert.equal(results.filter(r => r.sent).length, 1);
      assert.equal(results.filter(r => !r.sent).length, 1);
    } finally {
      await nodeA.stop();
      await nodeB.stop();
    }
  }));
});
