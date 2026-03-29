// iaADN - Aggregator: combines sub-query responses into a coherent final answer
// The final step of hive mind processing

export class ResponseAggregator {
  constructor({ inferenceEngine }) {
    this.inferenceEngine = inferenceEngine;
  }

  // Aggregate responses based on strategy
  async aggregate(responses, originalQuery, strategy = 'merge') {
    switch (strategy) {
      case 'pipeline':
        return this._pipelineAggregate(responses);
      case 'merge':
        return this._mergeAggregate(responses, originalQuery);
      case 'vote':
        return this._voteAggregate(responses);
      default:
        return this._mergeAggregate(responses, originalQuery);
    }
  }

  // Pipeline: chain responses sequentially
  _pipelineAggregate(responses) {
    // Concatenate in dependency order
    const sorted = [...responses].sort((a, b) => {
      const aId = parseInt(a.subQueryId?.replace('sq_', '') || '0');
      const bId = parseInt(b.subQueryId?.replace('sq_', '') || '0');
      return aId - bId;
    });

    const combined = sorted.map(r => r.content).join('\n\n');
    return { content: combined, strategy: 'pipeline', responseCount: responses.length };
  }

  // Merge: use AI to synthesize all responses into one coherent answer
  async _mergeAggregate(responses, originalQuery) {
    if (responses.length === 1) {
      return { content: responses[0].content, strategy: 'single', responseCount: 1 };
    }

    // If inference engine available, use AI to synthesize
    if (this.inferenceEngine?.ready) {
      try {
        const responseSummary = responses
          .map((r, i) => `[Part ${i + 1}]: ${r.content}`)
          .join('\n\n');

        const result = await this.inferenceEngine.complete([
          {
            role: 'user',
            content: `Original question: "${originalQuery}"

Multiple AI instances provided these partial answers:

${responseSummary}

Synthesize these into ONE coherent, complete answer. Remove any redundancy. Keep it concise.`,
          },
        ], { temperature: 0.3, maxTokens: 1024 });

        return { content: result.content, strategy: 'ai_merge', responseCount: responses.length };
      } catch {
        // AI merge failed, fallback to concat
      }
    }

    // Fallback: simple concatenation
    return this._pipelineAggregate(responses);
  }

  // Vote: when multiple instances answer the same query, pick the best
  _voteAggregate(responses) {
    if (responses.length === 0) {
      return { content: '', strategy: 'vote', responseCount: 0 };
    }

    // Pick the response from the instance with highest fitness
    const best = responses.reduce((best, r) => {
      return (r.fitness ?? 0) > (best.fitness ?? 0) ? r : best;
    });

    return {
      content: best.content,
      strategy: 'vote',
      responseCount: responses.length,
      selectedInstance: best.instanceId,
    };
  }
}
