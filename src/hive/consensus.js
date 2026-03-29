// iaADN - Consensus: resolves conflicts when instances disagree
// When multiple AIs give different answers, consensus determines truth

export class HiveConsensus {
  constructor() {}

  // Resolve conflicting responses
  resolve(responses, method = 'fitness_weighted') {
    if (responses.length <= 1) {
      return responses[0] || null;
    }

    switch (method) {
      case 'majority':
        return this.majorityVote(responses);
      case 'fitness_weighted':
        return this.fitnessWeightedVote(responses);
      case 'confidence':
        return this.confidenceWeighted(responses);
      default:
        return this.fitnessWeightedVote(responses);
    }
  }

  // Simple majority: group similar responses, pick the largest group
  majorityVote(responses) {
    const groups = this._groupSimilar(responses);
    const largest = groups.sort((a, b) => b.length - a.length)[0];

    return {
      content: largest[0].content,
      confidence: largest.length / responses.length,
      method: 'majority',
      groupSize: largest.length,
      totalResponses: responses.length,
    };
  }

  // Fitness-weighted vote: responses from fitter instances count more
  fitnessWeightedVote(responses) {
    const groups = this._groupSimilar(responses);

    let bestGroup = null;
    let bestWeight = -1;

    for (const group of groups) {
      const weight = group.reduce((sum, r) => sum + (r.fitness ?? 0.5), 0);
      if (weight > bestWeight) {
        bestWeight = weight;
        bestGroup = group;
      }
    }

    // Pick the response with highest fitness from the winning group
    const best = bestGroup.sort((a, b) => (b.fitness ?? 0) - (a.fitness ?? 0))[0];

    return {
      content: best.content,
      confidence: bestWeight / responses.reduce((s, r) => s + (r.fitness ?? 0.5), 0),
      method: 'fitness_weighted',
      selectedInstance: best.instanceId,
      totalResponses: responses.length,
    };
  }

  // Confidence-weighted: each instance reports its own confidence
  confidenceWeighted(responses) {
    const best = responses.reduce((best, r) => {
      const conf = r.confidence ?? 0.5;
      return conf > (best.confidence ?? 0) ? r : best;
    });

    return {
      content: best.content,
      confidence: best.confidence ?? 0.5,
      method: 'confidence',
      selectedInstance: best.instanceId,
      totalResponses: responses.length,
    };
  }

  // Group similar responses together (by word overlap)
  _groupSimilar(responses, threshold = 0.5) {
    const groups = [];

    for (const response of responses) {
      let placed = false;

      for (const group of groups) {
        const similarity = this._textSimilarity(response.content, group[0].content);
        if (similarity > threshold) {
          group.push(response);
          placed = true;
          break;
        }
      }

      if (!placed) {
        groups.push([response]);
      }
    }

    return groups;
  }

  // Simple text similarity (Jaccard on words)
  _textSimilarity(textA, textB) {
    const wordsA = new Set((textA || '').toLowerCase().split(/\s+/));
    const wordsB = new Set((textB || '').toLowerCase().split(/\s+/));
    const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
    const union = new Set([...wordsA, ...wordsB]);
    return union.size > 0 ? intersection.size / union.size : 0;
  }
}
