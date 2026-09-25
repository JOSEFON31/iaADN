// iaADN - Node identity and signed-genome tests (Fase 4)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadOrCreateIdentity, signHash, verifyHash } from '../src/network/identity.js';
import { GenomeCodec } from '../src/genome/codec.js';
import { Genome } from '../src/genome/genome.js';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'iaadn-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('node identity', () => {
  it('generates a keypair, persists it (owner-only), and reloads the same one', () => withTempDir(dir => {
    const keyFile = join(dir, 'node.key');
    const a = loadOrCreateIdentity(keyFile);
    assert.equal(typeof a.publicKeyBase64, 'string');
    assert.equal((statSync(keyFile).mode & 0o777).toString(8), '600');

    const b = loadOrCreateIdentity(keyFile);
    assert.equal(a.publicKeyBase64, b.publicKeyBase64);
  }));

  it('two different nodes get different keys', () => withTempDir(dir => {
    const a = loadOrCreateIdentity(join(dir, 'a.key'));
    const b = loadOrCreateIdentity(join(dir, 'b.key'));
    assert.notEqual(a.publicKeyBase64, b.publicKeyBase64);
  }));

  it('signHash/verifyHash round-trip, and reject tampering', () => withTempDir(dir => {
    const identity = loadOrCreateIdentity(join(dir, 'node.key'));
    const sig = signHash('some-hash', identity.privateKey);

    assert.equal(verifyHash('some-hash', sig, identity.publicKeyBase64), true);
    assert.equal(verifyHash('different-hash', sig, identity.publicKeyBase64), false);
    assert.equal(verifyHash('some-hash', sig, 'not-a-real-key'), false);
    assert.equal(verifyHash('some-hash', 'not-a-real-signature', identity.publicKeyBase64), false);
  }));
});

describe('GenomeCodec signed transfer format (Fase 4)', () => {
  it('an unsigned envelope is accepted when signature is not required', () => {
    const genome = Genome.createGenesis('node-a');
    const envelope = GenomeCodec.toTransferFormat(genome);
    const { genome: decoded, verified } = GenomeCodec.fromTransferFormat(envelope);
    assert.equal(decoded.instanceId, genome.instanceId);
    assert.equal(verified, false);
  });

  it('an unsigned envelope is rejected when signature is required', () => {
    const genome = Genome.createGenesis('node-a');
    const envelope = GenomeCodec.toTransferFormat(genome);
    assert.throws(() => GenomeCodec.fromTransferFormat(envelope, { requireSignature: true }));
  });

  it('a validly signed envelope is accepted and marked verified', () => withTempDir(dir => {
    const identity = loadOrCreateIdentity(join(dir, 'node.key'));
    const genome = Genome.createGenesis('node-a');
    const envelope = GenomeCodec.toTransferFormat(genome, identity);

    const { genome: decoded, verified, publicKey } = GenomeCodec.fromTransferFormat(envelope, { requireSignature: true });
    assert.equal(decoded.instanceId, genome.instanceId);
    assert.equal(verified, true);
    assert.equal(publicKey, identity.publicKeyBase64);
  }));

  it('a tampered payload fails signature verification', () => withTempDir(dir => {
    const identity = loadOrCreateIdentity(join(dir, 'node.key'));
    const genome = Genome.createGenesis('node-a');
    const envelope = GenomeCodec.toTransferFormat(genome, identity);

    envelope.payload.generation = 999; // tamper after signing

    assert.throws(() => GenomeCodec.fromTransferFormat(envelope, { requireSignature: true }));
  }));

  it('a genome signed by one node cannot be passed off as another node\'s', () => withTempDir(dir => {
    const attacker = loadOrCreateIdentity(join(dir, 'attacker.key'));
    const genome = Genome.createGenesis('node-a');
    const envelope = GenomeCodec.toTransferFormat(genome, attacker);

    const victim = loadOrCreateIdentity(join(dir, 'victim.key'));
    envelope.publicKey = victim.publicKeyBase64; // claim it's from the victim instead

    const { verified } = GenomeCodec.fromTransferFormat(envelope);
    assert.equal(verified, false);
  }));
});
