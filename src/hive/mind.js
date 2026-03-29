// iaADN - Hive Mind: the collective intelligence coordinator
// Receives a query, decomposes it, distributes to specialized instances,
// collects responses, builds consensus, and returns a coherent answer

import { QueryDecomposer } from './decomposer.js';
import { QueryDistributor } from './distributor.js';
import { ResponseAggregator } from './aggregator.js';
import { HiveConsensus } from './consensus.js';

export class HiveMind {
  constructor({ population, inferenceEngine, node }) {
    this.population = population;
    this.inferenceEngine = inferenceEngine;
    this.node = node;

    this.decomposer = new QueryDecomposer({ inferenceEngine });
    this.distributor = new QueryDistributor({ population, node });
    this.aggregator = new ResponseAggregator({ inferenceEngine });
    this.consensus = new HiveConsensus();

    this.queryHistory = [];
  }

  // Process a query through the entire hive mind pipeline
  async query(userQuery) {
    const startTime = Date.now();

    // 1. Decompose the query into sub-queries
    const decomposition = await this.decomposer.decompose(userQuery);
    const { subQueries, strategy: decompStrategy } = decomposition;

    // 2. Distribute sub-queries to instances
    const assignments = await this.distributor.distribute(subQueries);

    // 3. Execute each sub-query
    const responses = [];

    for (const assignment of assignments) {
      try {
        const response = await this._executeSubQuery(assignment);
        responses.push(response);
      } catch (err) {
        responses.push({
          subQueryId: assignment.subQuery.id,
          content: `[Error: ${err.message}]`,
          instanceId: assignment.instanceId,
          fitness: 0,
        });
      }
    }

    // 4. Aggregate responses
    let finalResponse;
    if (subQueries.length === 1) {
      finalResponse = responses[0];
    } else {
      // Check if responses conflict
      const hasConflict = this._detectConflict(responses);

      if (hasConflict) {
        // Use consensus to resolve
        const resolved = this.consensus.resolve(responses, 'fitness_weighted');
        finalResponse = resolved;
      } else {
        // Merge responses into coherent answer
        finalResponse = await this.aggregator.aggregate(responses, userQuery, 'merge');
      }
    }

    const elapsed = Date.now() - startTime;

    const result = {
      query: userQuery,
      response: finalResponse.content,
      metadata: {
        decomposition: decompStrategy,
        subQueries: subQueries.length,
        instancesUsed: [...new Set(assignments.map(a => a.instanceId).filter(Boolean))].length,
        elapsed,
        consensus: finalResponse.method || null,
        confidence: finalResponse.confidence || null,
      },
    };

    // Record in history
    this.queryHistory.push({
      ...result,
      timestamp: Date.now(),
    });
    if (this.queryHistory.length > 100) this.queryHistory.shift();

    return result;
  }

  // Execute a single sub-query on an assigned instance
  async _executeSubQuery(assignment) {
    const { subQuery, instanceId } = assignment;

    if (!this.inferenceEngine?.ready) {
      return {
        subQueryId: subQuery.id,
        content: `[Inference engine not available]`,
        instanceId,
        fitness: 0,
      };
    }

    // Find the instance's genome for its system prompt and config
    const instance = instanceId
      ? this.population.instances.get(instanceId)
      : this.population.getBest();

    const genome = instance?.genome;
    const systemPrompt = genome?.getSystemPrompt() || '';
    const config = genome?.getInferenceConfig() || {};

    const result = await this.inferenceEngine.complete(
      [{ role: 'user', content: subQuery.query }],
      {
        systemPrompt,
        temperature: config.temperature || 0.7,
        maxTokens: config.maxTokens || 512,
      }
    );

    return {
      subQueryId: subQuery.id,
      content: result.content,
      instanceId: genome?.instanceId || null,
      fitness: instance?.fitness ?? 0.5,
    };
  }

  // Detect if responses significantly disagree
  _detectConflict(responses) {
    if (responses.length < 2) return false;

    // Compare all pairs
    for (let i = 0; i < responses.length; i++) {
      for (let j = i + 1; j < responses.length; j++) {
        const similarity = this._textSimilarity(
          responses[i].content,
          responses[j].content
        );
        if (similarity < 0.3) return true; // significant disagreement
      }
    }

    return false;
  }

  _textSimilarity(a, b) {
    const wordsA = new Set((a || '').toLowerCase().split(/\s+/));
    const wordsB = new Set((b || '').toLowerCase().split(/\s+/));
    const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
    const union = new Set([...wordsA, ...wordsB]);
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  // Get query history
  getHistory() {
    return [...this.queryHistory];
  }

  // Get hive mind statistics
  getStats() {
    return {
      totalQueries: this.queryHistory.length,
      avgResponseTime: this.queryHistory.length > 0
        ? Math.round(this.queryHistory.reduce((s, q) => s + q.metadata.elapsed, 0) / this.queryHistory.length)
        : 0,
    };
  }
}
