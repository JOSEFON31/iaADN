// iaADN - Decomposer: breaks complex queries into sub-queries
// The first step of hive mind processing — divide and conquer

export class QueryDecomposer {
  constructor({ inferenceEngine }) {
    this.inferenceEngine = inferenceEngine;
  }

  // Decompose a complex query into sub-queries
  async decompose(query) {
    // First, check if decomposition is even needed
    if (query.length < 100 && !this._isComplex(query)) {
      return {
        strategy: 'direct',
        subQueries: [{ id: 'sq_0', query, type: this._classifyType(query), dependencies: [] }],
      };
    }

    // Use local AI to analyze and decompose
    if (this.inferenceEngine?.ready) {
      return this._aiDecompose(query);
    }

    // Fallback: simple rule-based decomposition
    return this._ruleBasedDecompose(query);
  }

  // AI-powered decomposition
  async _aiDecompose(query) {
    try {
      const result = await this.inferenceEngine.complete([
        {
          role: 'user',
          content: `Analyze this query and break it into independent sub-tasks. Return JSON format:
{"subQueries": [{"id": "sq_0", "query": "...", "type": "code|analysis|research|creative|general", "dependencies": []}]}

Query: "${query.slice(0, 500)}"

Rules:
- Maximum 5 sub-queries
- Each should be independently solvable
- Use dependencies array if one sub-query needs another's result first
- Type determines which AI specialist handles it

Respond with ONLY valid JSON.`,
        },
      ], { temperature: 0.2, maxTokens: 512 });

      const parsed = JSON.parse(result.content);
      if (parsed.subQueries && Array.isArray(parsed.subQueries)) {
        return {
          strategy: 'ai_decomposed',
          subQueries: parsed.subQueries.slice(0, 10),
        };
      }
    } catch {
      // AI decomposition failed, fallback
    }

    return this._ruleBasedDecompose(query);
  }

  // Simple rule-based decomposition
  _ruleBasedDecompose(query) {
    const subQueries = [];
    const sentences = query.split(/[.!?]+/).filter(s => s.trim().length > 10);

    if (sentences.length <= 1) {
      return {
        strategy: 'direct',
        subQueries: [{ id: 'sq_0', query, type: this._classifyType(query), dependencies: [] }],
      };
    }

    for (let i = 0; i < Math.min(sentences.length, 5); i++) {
      subQueries.push({
        id: `sq_${i}`,
        query: sentences[i].trim(),
        type: this._classifyType(sentences[i]),
        dependencies: [],
      });
    }

    return { strategy: 'rule_based', subQueries };
  }

  // Check if a query is complex enough to decompose
  _isComplex(query) {
    const indicators = [' and ', ' also ', ' additionally ', ' moreover ', ' furthermore ', 'first ', 'then ', 'finally '];
    return indicators.some(ind => query.toLowerCase().includes(ind));
  }

  // Classify query type
  _classifyType(query) {
    const lower = query.toLowerCase();
    if (/code|function|program|debug|error|syntax|api/i.test(lower)) return 'code';
    if (/analyze|compare|evaluate|assess|review/i.test(lower)) return 'analysis';
    if (/research|find|search|discover|investigate/i.test(lower)) return 'research';
    if (/write|create|design|imagine|story|poem/i.test(lower)) return 'creative';
    return 'general';
  }
}
