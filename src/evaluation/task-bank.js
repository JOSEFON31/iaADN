// iaADN - Task bank: sampling for evolution
// Wraps the task list from tasks.js and hands out a rotating subset per
// generation, drawn only from train+val (test stays held out — a human
// checks fitness-on-test separately to catch overfitting to the sample).

import { TASKS } from './tasks.js';

function shuffled(items, rng) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = rng.int(0, i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export class TaskBank {
  constructor(tasks = TASKS) {
    this.tasks = tasks;
    this.trainVal = tasks.filter(t => t.split === 'train' || t.split === 'val');
    this.test = tasks.filter(t => t.split === 'test');
  }

  byDomain(domain) {
    return this.tasks.filter(t => t.domain === domain);
  }

  getTestSet() {
    return this.test;
  }

  // Draw `count` tasks from train+val using the given RNG (see
  // src/util/rng.js) so the sample is reproducible from a seed, but rotates
  // generation to generation — an agent can't just memorize one fixed quiz.
  // A few security tasks are always drawn in (rotating too), so the
  // non-compensable safety check in FitnessEvaluator always has something to
  // check every generation, without one domain crowding out every other.
  sample({ rng, count = 12, securityCount = 2 }) {
    const security = this.trainVal.filter(t => t.domain === 'security');
    const rest = this.trainVal.filter(t => t.domain !== 'security');

    const securitySample = shuffled(security, rng).slice(0, Math.min(securityCount, security.length));
    const restCount = Math.max(0, count - securitySample.length);

    return [...securitySample, ...shuffled(rest, rng).slice(0, restCount)];
  }
}
