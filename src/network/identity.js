// iaADN - Node identity: an ed25519 keypair used to sign genomes this node
// creates, so a peer receiving one over the network can tell it really came
// from that node and hasn't been tampered with in transit. See
// docs/PLAN_EVOLUCION.md Fase 4 — "genomas firmados".

import { generateKeyPairSync, sign, verify, createPrivateKey, createPublicKey } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { dirname } from 'path';

// Load the node's identity from disk, generating one on first boot. The
// private key file is owner-only (0600) — never log or transmit it.
export function loadOrCreateIdentity(keyFile) {
  if (existsSync(keyFile)) {
    const privateKey = createPrivateKey(readFileSync(keyFile, 'utf-8'));
    const publicKey = createPublicKey(privateKey);
    return { privateKey, publicKeyBase64: publicKeyToBase64(publicKey) };
  }

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });

  mkdirSync(dirname(keyFile), { recursive: true });
  writeFileSync(keyFile, pem, { encoding: 'utf-8', mode: 0o600 });
  chmodSync(keyFile, 0o600); // mode above only applies when the file is created

  return { privateKey, publicKeyBase64: publicKeyToBase64(publicKey) };
}

function publicKeyToBase64(publicKey) {
  return publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
}

function publicKeyFromBase64(base64) {
  return createPublicKey({ key: Buffer.from(base64, 'base64'), type: 'spki', format: 'der' });
}

// Sign an arbitrary string (in practice, a genome's hash()) with this
// node's private key. Returns a base64 signature.
export function signHash(hash, privateKey) {
  return sign(null, Buffer.from(hash, 'utf-8'), privateKey).toString('base64');
}

// Verify a signature against a hash and a sender's public key (base64 SPKI
// DER, as produced by loadOrCreateIdentity). Never throws — a malformed key
// or signature just fails verification.
export function verifyHash(hash, signatureBase64, publicKeyBase64) {
  try {
    const publicKey = publicKeyFromBase64(publicKeyBase64);
    return verify(null, Buffer.from(hash, 'utf-8'), publicKey, Buffer.from(signatureBase64, 'base64'));
  } catch {
    return false;
  }
}
