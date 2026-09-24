// iaADN - RNG Tests
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Rng } from '../src/util/rng.js';

describe('Rng', () => {
  it('produces the same sequence for the same seed', () => {
    const a = new Rng('fixed-seed');
    const b = new Rng('fixed-seed');
    const seqA = Array.from({ length: 20 }, () => a.random());
    const seqB = Array.from({ length: 20 }, () => b.random());
    assert.deepEqual(seqA, seqB);
  });

  it('produces different sequences for different seeds', () => {
    const a = new Rng('seed-one');
    const b = new Rng('seed-two');
    const seqA = Array.from({ length: 5 }, () => a.random());
    const seqB = Array.from({ length: 5 }, () => b.random());
    assert.notDeepEqual(seqA, seqB);
  });

  it('random() stays within [0, 1)', () => {
    const r = new Rng('range-check');
    for (let i = 0; i < 1000; i++) {
      const v = r.random();
      assert.ok(v >= 0 && v < 1, `value out of range: ${v}`);
    }
  });

  it('int(min, max) returns integers within [min, max)', () => {
    const r = new Rng('int-check');
    for (let i = 0; i < 200; i++) {
      const v = r.int(3, 9);
      assert.ok(Number.isInteger(v));
      assert.ok(v >= 3 && v < 9, `value out of range: ${v}`);
    }
  });

  it('pick() only returns elements from the array', () => {
    const r = new Rng('pick-check');
    const options = ['a', 'b', 'c'];
    for (let i = 0; i < 50; i++) {
      assert.ok(options.includes(r.pick(options)));
    }
  });

  it('reseed() resets the sequence deterministically', () => {
    const r = new Rng('initial');
    const first = r.random();
    r.reseed('initial');
    assert.equal(r.random(), first);
  });
});
