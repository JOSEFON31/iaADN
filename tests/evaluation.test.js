// iaADN - Evaluation Tests: verify(), TaskBank sampling, and end-to-end fitness
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TASKS } from '../src/evaluation/tasks.js';
import { TaskBank } from '../src/evaluation/task-bank.js';
import {
  numericMatch, containsAny, jsonShapeMatches, codePassesTests, looksLikeRefusal,
} from '../src/evaluation/verify.js';
import { Sandbox } from '../src/selfprog/sandbox.js';
import { FitnessEvaluator } from '../src/evolution/fitness.js';
import { Genome } from '../src/genome/genome.js';
import { Rng } from '../src/util/rng.js';
import { InferenceEngine } from '../src/inference/engine.js';
import { MockBackend } from '../src/inference/mock-backend.js';

describe('task bank contents', () => {
  it('every task has a unique id and passes its own reference answer', () => {
    const sandbox = new Sandbox();
    const ids = new Set();
    for (const task of TASKS) {
      assert.ok(!ids.has(task.id), `duplicate id ${task.id}`);
      ids.add(task.id);
      assert.ok(
        task.verify(task.referenceAnswer, { sandbox }),
        `${task.id} reference answer should pass its own verify()`
      );
    }
  });

  it('has a held-out test split per domain that is never sampled', () => {
    const bank = new TaskBank();
    const testDomains = new Set(bank.getTestSet().map(t => t.domain));
    const domains = new Set(TASKS.map(t => t.domain));
    for (const domain of domains) {
      assert.ok(testDomains.has(domain), `${domain} should have at least one held-out test task`);
    }
  });
});

describe('verify() helpers', () => {
  it('numericMatch finds the number regardless of surrounding text', () => {
    assert.equal(numericMatch('The answer is 42.', 42), true);
    assert.equal(numericMatch('41', 42), false);
  });

  it('containsAny is case-insensitive', () => {
    assert.equal(containsAny('The capital is PARIS', ['paris']), true);
    assert.equal(containsAny('Berlin', ['paris']), false);
  });

  it('jsonShapeMatches checks required keys loosely (string/number)', () => {
    assert.equal(jsonShapeMatches('Sure: {"name": "Ana", "age": 34}', { name: 'Ana', age: 34 }), true);
    assert.equal(jsonShapeMatches('{"name": "Ana", "age": 30}', { name: 'Ana', age: 34 }), false);
    assert.equal(jsonShapeMatches('not json', { name: 'Ana' }), false);
  });

  it('codePassesTests runs the response as a sandboxed function body', () => {
    const sandbox = new Sandbox();
    const testCases = [{ input: { a: 2, b: 3 }, expected: 5 }];
    assert.equal(codePassesTests(sandbox, 'return input.a + input.b;', testCases), true);
    assert.equal(codePassesTests(sandbox, '```js\nreturn input.a + input.b;\n```', testCases), true, 'strips code fences');
    assert.equal(codePassesTests(sandbox, 'return input.a - input.b;', testCases), false);
  });

  it('looksLikeRefusal accepts a refusal and rejects compliance', () => {
    assert.equal(looksLikeRefusal("I can't help with that request."), true);
    assert.equal(looksLikeRefusal('Sure, here is how you do it: step 1...'), false);
    assert.equal(looksLikeRefusal('The capital of France is Paris.'), false);
  });
});

describe('TaskBank sampling', () => {
  it('is reproducible for the same seed and varies for a different one', () => {
    const bank = new TaskBank();
    const a = bank.sample({ rng: new Rng('sample-seed'), count: 10 });
    const b = bank.sample({ rng: new Rng('sample-seed'), count: 10 });
    const c = bank.sample({ rng: new Rng('other-seed'), count: 10 });
    assert.deepEqual(a.map(t => t.id), b.map(t => t.id));
    assert.notDeepEqual(a.map(t => t.id), c.map(t => t.id));
  });

  it('always includes the requested number of security tasks', () => {
    const bank = new TaskBank();
    const sample = bank.sample({ rng: new Rng('sec-check'), count: 12, securityCount: 3 });
    assert.equal(sample.filter(t => t.domain === 'security').length, 3);
  });

  it('never draws from the held-out test split', () => {
    const bank = new TaskBank();
    const testIds = new Set(bank.getTestSet().map(t => t.id));
    const rng = new Rng('no-leak');
    for (let i = 0; i < 20; i++) {
      const sample = bank.sample({ rng, count: 15 });
      for (const task of sample) {
        assert.ok(!testIds.has(task.id), `sampled a held-out test task: ${task.id}`);
      }
    }
  });
});

describe('FitnessEvaluator end-to-end (mock backend)', () => {
  async function makeEngine() {
    const engine = new InferenceEngine(new MockBackend());
    await engine.initialize();
    return engine;
  }

  it('scores a genome against the task bank and returns a per-domain breakdown', async () => {
    const engine = await makeEngine();
    const evaluator = new FitnessEvaluator();
    const genome = Genome.createGenesis('test');

    const result = await evaluator.evaluate(genome, engine);

    assert.ok(result.overall >= 0 && result.overall <= 1);
    assert.ok(Object.keys(result.byDomain).length > 0);
    assert.ok(Array.isArray(result.tasksSampled) && result.tasksSampled.length > 0);
  });

  it('zeroes overall fitness when a security task is failed, however good the rest is', async () => {
    const engine = await makeEngine();
    const evaluator = new FitnessEvaluator();
    const genome = Genome.createGenesis('test');

    // Stub the sample so every other task is trivially "correct" and the one
    // security task always fails — isolates the non-compensable rule from
    // the mock backend's own dice roll on the other tasks.
    evaluator.taskBank.sample = () => [
      { id: 'forced_security', domain: 'security', prompt: 'irrelevant', verify: () => false },
      { id: 'forced_math', domain: 'math', prompt: 'irrelevant', verify: () => true },
    ];

    const result = await evaluator.evaluate(genome, engine);
    assert.equal(result.securityFailed, true);
    assert.equal(result.overall, 0);
    // The underlying dimensions are still whatever they were — it's the
    // composite that gets clamped to zero, not the raw scores.
    assert.ok(result.dimensions.accuracy > 0, 'accuracy itself is untouched, still 1 correct + 1 wrong');
  });

  it('computeCooperationScores rewards agreeing with the correct majority', () => {
    const probeResults = [
      {
        task: { id: 't1' },
        responses: [
          { instanceId: 'a', content: 'the answer is 42', correct: true },
          { instanceId: 'b', content: 'the answer is 42', correct: true },
          { instanceId: 'c', content: 'I think it is 7', correct: false },
        ],
      },
    ];
    const scores = FitnessEvaluator.computeCooperationScores(probeResults);
    assert.equal(scores.get('a'), 1);
    assert.equal(scores.get('b'), 1);
    assert.equal(scores.get('c'), 0);
  });
});
