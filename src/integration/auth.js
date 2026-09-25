// iaADN - API auth helpers: bearer-token check and per-IP rate limiting
// Used by src/integration/api.js to keep the API private by default.

import { createHash, timingSafeEqual } from 'crypto';

// Check an `Authorization: Bearer <token>` header against the expected token.
// Both sides are hashed first so timingSafeEqual always compares equal-length
// buffers, and the comparison time doesn't depend on the input.
export function verifyToken(header, expected) {
  if (!expected || typeof header !== 'string') return false;
  const match = header.match(/^Bearer\s+(\S+)$/i);
  if (!match) return false;

  const given = createHash('sha256').update(match[1]).digest();
  const want = createHash('sha256').update(expected).digest();
  return timingSafeEqual(given, want);
}

// Fixed-window request counter per client IP, in memory.
export class RateLimiter {
  constructor({ windowMs = 60 * 1000, max = 30 } = {}) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map(); // ip -> { count, resetAt }
  }

  check(ip, now = Date.now()) {
    // Drop expired windows so the map can't grow without bound
    for (const [key, entry] of this.hits) {
      if (entry.resetAt <= now) this.hits.delete(key);
    }

    let entry = this.hits.get(ip);
    if (!entry) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(ip, entry);
    }

    entry.count++;
    if (entry.count > this.max) {
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
    }
    return { allowed: true, retryAfterSec: 0 };
  }
}
