// iaADN - Hive Mind Tests
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { QueryDecomposer } from '../src/hive/decomposer.js';
import { ResponseAggregator } from '../src/hive/aggregator.js';
import { HiveConsensus } from '../src/hive/consensus.js';
import { QueryRouter } from '../src/hive/router.js';

describe('QueryDecomposer', () => {
  it('should not decompose simple queries', async () => {
    const decomposer = new QueryDecomposer({});
    const result = await decomposer.decompose('What is 2+2?');
    assert.equal(result.strategy, 'direct');
    assert.equal(result.subQueries.length, 1);
  });

  it('should decompose multi-sentence queries', async () => {
    const decomposer = new QueryDecomposer({});
    const result = await decomposer.decompose(
      'Explain how neural networks work. Then compare them to traditional algorithms. Finally, suggest which is better for image classification.'
    );
    assert.ok(result.subQueries.length >= 2);
  });

  it('should classify query types', async () => {
    const decomposer = new QueryDecomposer({});
    const code = await decomposer.decompose('Write a JavaScript function to sort an array using code');
    assert.equal(code.subQueries[0].type, 'code');

    const analysis = await decomposer.decompose('Analyze and evaluate the performance complexity of this system');
    assert.equal(analysis.subQueries[0].type, 'analysis');
  });
});

describe('ResponseAggregator', () => {
  it('should return single response directly', async () => {
    const aggregator = new ResponseAggregator({});
    const result = await aggregator.aggregate(
      [{ subQueryId: 'sq_0', content: 'The answer is 42' }],
      'What is the answer?',
      'merge'
    );
    assert.equal(result.content, 'The answer is 42');
  });

  it('should merge multiple responses', async () => {
    const aggregator = new ResponseAggregator({});
    const result = await aggregator.aggregate(
      [
        { subQueryId: 'sq_0', content: 'Part 1 of the answer' },
        { subQueryId: 'sq_1', content: 'Part 2 of the answer' },
      ],
      'Tell me everything',
      'pipeline'
    );
    assert.ok(result.content.includes('Part 1'));
    assert.ok(result.content.includes('Part 2'));
    assert.equal(result.responseCount, 2);
  });

  it('should pick best response in vote mode', async () => {
    const aggregator = new ResponseAggregator({});
    const result = await aggregator.aggregate(
      [
        { subQueryId: 'sq_0', content: 'Bad answer', fitness: 0.2 },
        { subQueryId: 'sq_0', content: 'Good answer', fitness: 0.9, instanceId: 'best' },
      ],
      'What?',
      'vote'
    );
    assert.equal(result.content, 'Good answer');
    assert.equal(result.selectedInstance, 'best');
  });
});

describe('HiveConsensus', () => {
  it('should resolve via majority vote', () => {
    const consensus = new HiveConsensus();
    const result = consensus.resolve([
      { content: 'The answer is 42', fitness: 0.5 },
      { content: 'The answer is 42', fitness: 0.6 },
      { content: 'The answer is 7', fitness: 0.4 },
    ], 'majority');
    assert.ok(result.content.includes('42'));
    assert.ok(result.confidence > 0.5);
  });

  it('should resolve via fitness-weighted vote', () => {
    const consensus = new HiveConsensus();
    const result = consensus.resolve([
      { content: 'Wrong answer', fitness: 0.1, instanceId: 'weak' },
      { content: 'Correct answer from expert', fitness: 0.95, instanceId: 'expert' },
    ], 'fitness_weighted');
    assert.equal(result.selectedInstance, 'expert');
  });

  it('should handle single response', () => {
    const consensus = new HiveConsensus();
    const result = consensus.resolve([
      { content: 'Only response', fitness: 0.7 },
    ]);
    assert.equal(result.content, 'Only response');
  });
});

describe('QueryRouter', () => {
  it('should route simple queries directly', async () => {
    const mockPop = { getLiving: () => [{ genome: { getSpecialization: () => ({ general: 0.8 }) }, fitness: 0.7 }] };
    const router = new QueryRouter({ population: mockPop, node: { peers: new Map() } });
    const route = await router.route('Hello');
    assert.equal(route.strategy, 'direct');
  });

  it('should route complex queries to hive mind', async () => {
    const mockPop = { getLiving: () => [{ genome: { getSpecialization: () => ({ general: 0.5 }) }, fitness: 0.5 }] };
    const router = new QueryRouter({ population: mockPop, node: { peers: new Map() } });
    const route = await router.route(
      'First analyze the codebase structure, and then create a new module for authentication. After that, write comprehensive tests. Additionally, update the documentation. Finally, deploy to staging.'
    );
    assert.equal(route.strategy, 'hive_mind');
  });
});
