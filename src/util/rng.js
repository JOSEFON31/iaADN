// iaADN - Deterministic RNG: seedable pseudo-random generator
// Every evolutionary decision (mutation, crossover, selection, genesis
// variation) draws from this single source instead of Math.random(), so a
// whole run can be replayed exactly from its seed. See docs/PLAN_EVOLUCION.md
// section "0. Cimientos" — "Semilla aleatoria configurable y registrada".

import { randomBytes } from 'crypto';

// mulberry32 — small, fast, good enough statistical quality for evolutionary
// search (not cryptographic; that's fine, this is for reproducible search,
// not security).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Map an arbitrary string seed to a 32-bit integer state (FNV-1a).
function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class Rng {
  constructor(seed) {
    this.reseed(seed ?? Rng.generateSeed());
  }

  // A short, human-loggable random seed (used when none is configured).
  static generateSeed() {
    return randomBytes(4).toString('hex');
  }

  reseed(seed) {
    this.seed = String(seed);
    this._next = mulberry32(hashSeed(this.seed));
  }

  // Drop-in replacement for Math.random(): float in [0, 1)
  random() {
    return this._next();
  }

  // Integer in [min, max)
  int(min, max) {
    return Math.floor(this.random() * (max - min)) + min;
  }

  // Pick a random element from an array
  pick(arr) {
    return arr[this.int(0, arr.length)];
  }
}

// Process-wide default instance. Evolutionary code imports `rng` and calls
// rng.random()/rng.int() wherever it used to call Math.random() — this is
// the single choke point that makes a whole run reproducible from one seed.
export const rng = new Rng();

// Re-seed the shared RNG (called once at boot with the configured or a
// freshly generated seed) and return the seed actually used.
export function initRng(seed) {
  rng.reseed(seed ?? Rng.generateSeed());
  return rng.seed;
}

export function getSeed() {
  return rng.seed;
}
