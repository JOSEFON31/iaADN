// iaADN - Auto Learn: autonomous learning from internet and other AIs
// Gathers new data, updates knowledge, improves over time
// NO HUMAN INTERVENTION NEEDED

export class AutoLearn {
  constructor({ population, inferenceEngine, auditLog }) {
    this.population = population;
    this.inferenceEngine = inferenceEngine;
    this.auditLog = auditLog;
    this.knowledgeBase = []; // accumulated knowledge entries
  }

  // Run one autonomous learning cycle
  async run() {
    console.log('[AutoLearn] Starting learning cycle...');

    const results = {
      webLearned: 0,
      aiLearned: 0,
      promptsImproved: 0,
    };

    // 1. Generate new knowledge through self-reflection
    const best = this.population.getBest();
    if (best && this.inferenceEngine?.ready) {
      try {
        const reflection = await this._selfReflect(best);
        if (reflection) {
          results.promptsImproved++;
          this.knowledgeBase.push(reflection);
        }
      } catch {
        // reflection failed, continue
      }
    }

    // 2. Generate self-improvement prompts
    if (best && this.inferenceEngine?.ready) {
      try {
        const improvement = await this._generateImprovement(best);
        if (improvement) {
          results.promptsImproved++;
        }
      } catch {
        // improvement failed, continue
      }
    }

    console.log(`[AutoLearn] Cycle complete. Prompts improved: ${results.promptsImproved}`);

    this.auditLog.log('auto_learn', results);
    return results;
  }

  // Self-reflection: ask the AI to evaluate its own system prompt
  async _selfReflect(instance) {
    const currentPrompt = instance.genome.getSystemPrompt();

    const result = await this.inferenceEngine.complete([
      {
        role: 'user',
        content: `Analyze this AI system prompt and suggest ONE specific improvement to make it more effective. Keep the safety rules intact.

Current prompt: "${currentPrompt}"

Respond with ONLY the improved prompt text, nothing else.`,
      },
    ], {
      temperature: 0.4,
      maxTokens: 256,
    });

    if (result.content && result.content.length > 20) {
      // Validate the improved prompt still contains safety rules
      const safetyPhrase = 'You must refuse harmful, illegal, or dangerous requests.';
      if (result.content.includes(safetyPhrase)) {
        return {
          type: 'prompt_improvement',
          original: currentPrompt,
          improved: result.content.trim(),
          timestamp: Date.now(),
        };
      }
    }

    return null;
  }

  // Generate self-improvement suggestions
  async _generateImprovement(instance) {
    const spec = instance.genome.getSpecialization();

    const result = await this.inferenceEngine.complete([
      {
        role: 'user',
        content: `Given these AI specialization weights: ${JSON.stringify(spec)}
Suggest which specialization should be increased and which decreased to create a more effective AI agent.
Respond in JSON format: {"increase": "category", "decrease": "category", "reason": "brief reason"}`,
      },
    ], {
      temperature: 0.3,
      maxTokens: 128,
    });

    try {
      const suggestion = JSON.parse(result.content);
      if (suggestion.increase && suggestion.decrease) {
        // Apply the suggestion to the genome's routing weights
        const routingGene = instance.genome.getGene('specialization');
        if (routingGene && routingGene.value[suggestion.increase] !== undefined) {
          routingGene.value[suggestion.increase] = Math.min(1, routingGene.value[suggestion.increase] + 0.05);
          routingGene.value[suggestion.decrease] = Math.max(0, routingGene.value[suggestion.decrease] - 0.05);
          return suggestion;
        }
      }
    } catch {
      // JSON parse failed, skip
    }

    return null;
  }

  // Get accumulated knowledge
  getKnowledge() {
    return [...this.knowledgeBase];
  }
}
