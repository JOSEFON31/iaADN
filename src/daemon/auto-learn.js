// iaADN - Auto Learn: autonomous learning from internet and other AIs
// Gathers new data, updates knowledge, improves over time
// NO HUMAN INTERVENTION NEEDED
//
// Both LLM-suggested changes below (system prompt, specialization weights)
// are applied to a *clone* of the best instance, evaluated for real with
// FitnessEvaluator, and only kept as a new instance if they don't regress —
// never written into the live instance's genome. Before this,
// _generateImprovement wrote the LLM's suggested specialization weights
// straight into the running genome with no check at all. See
// docs/PLAN_EVOLUCION.md Fase 2.

import { GenomeCodec } from '../genome/codec.js';

export class AutoLearn {
  constructor({ population, lineage, guardian, inferenceEngine, auditLog }) {
    this.population = population;
    this.lineage = lineage;
    this.guardian = guardian;
    this.inferenceEngine = inferenceEngine;
    this.auditLog = auditLog;
    this.knowledgeBase = []; // accumulated knowledge entries (proposals that were kept)
  }

  // Run one autonomous learning cycle
  async run() {
    console.log('[AutoLearn] Starting learning cycle...');

    const results = {
      webLearned: 0,
      aiLearned: 0,
      promptsImproved: 0,
      candidatesTried: 0,
    };

    const best = this.population.getBest();
    if (best && this.inferenceEngine?.ready) {
      for (const propose of [this._proposePromptImprovement, this._proposeSpecializationShift]) {
        try {
          const outcome = await this._tryCandidate(best, propose.bind(this));
          if (outcome) {
            results.candidatesTried++;
            if (outcome.kept) results.promptsImproved++;
          }
        } catch {
          // proposal or evaluation failed, continue to the next one
        }
      }
    }

    console.log(`[AutoLearn] Cycle complete. Candidates tried: ${results.candidatesTried}, kept: ${results.promptsImproved}`);

    this.auditLog.log('auto_learn', results);
    return results;
  }

  // Shared propose → build child → evaluate → keep-or-discard flow. `propose`
  // receives the current best instance and returns either null (nothing to
  // propose) or { mutate(childGenome), label, detail } where mutate() applies
  // the change to the child in place.
  async _tryCandidate(best, propose) {
    const proposal = await propose(best);
    if (!proposal) return null;

    const child = best.genome.replicate();
    proposal.mutate(child);

    const mutationCheck = this.guardian.validateMutation(best.genome, child);
    if (!mutationCheck.valid) {
      console.log(`[AutoLearn] ${proposal.label} rejected by guardian: ${mutationCheck.errors.join(', ')}`);
      return { kept: false, reason: 'guardian_rejected' };
    }

    const evaluation = await this.population.fitnessEvaluator.evaluate(child, this.inferenceEngine);
    const parentFitness = best.fitness ?? 0;

    if (evaluation.overall < parentFitness) {
      console.log(`[AutoLearn] ${proposal.label} scored worse (${evaluation.overall.toFixed(3)} < ${parentFitness.toFixed(3)}), discarding`);
      return { kept: false, reason: 'no_improvement', candidateFitness: evaluation.overall, parentFitness };
    }

    const spawnCheck = this.guardian.canSpawn();
    if (!spawnCheck.allowed) {
      console.log(`[AutoLearn] ${proposal.label} improved but cannot spawn: ${spawnCheck.reason}`);
      return { kept: false, reason: 'spawn_blocked' };
    }

    this.population.addInstance(child, evaluation.overall);
    this.lineage.recordBirth(child);
    this.guardian.resourceLimits.registerInstance();
    this.auditLog.logBirth(child);
    GenomeCodec.saveToFile(child);

    this.knowledgeBase.push({ ...proposal.detail, candidateFitness: evaluation.overall, parentFitness, timestamp: Date.now() });
    console.log(`[AutoLearn] New instance ${child.instanceId}: ${proposal.label} kept (fitness ${evaluation.overall.toFixed(3)} vs parent ${parentFitness.toFixed(3)})`);

    return { kept: true, instanceId: child.instanceId, candidateFitness: evaluation.overall, parentFitness };
  }

  // Ask the AI to suggest an improved system prompt (safety rules must stay)
  async _proposePromptImprovement(instance) {
    const currentPrompt = instance.genome.getSystemPrompt();

    const result = await this.inferenceEngine.complete([
      {
        role: 'user',
        content: `Analyze this AI system prompt and suggest ONE specific improvement to make it more effective. Keep the safety rules intact.

Current prompt: "${currentPrompt}"

Respond with ONLY the improved prompt text, nothing else.`,
      },
    ], { temperature: 0.4, maxTokens: 256 });

    if (!result.content || result.content.length <= 20) return null;

    const safetyPhrase = 'You must refuse harmful, illegal, or dangerous requests.';
    if (!result.content.includes(safetyPhrase)) return null; // never propose dropping the safety rule

    const improved = result.content.trim();
    return {
      label: 'prompt improvement',
      detail: { type: 'prompt_improvement', original: currentPrompt, improved },
      mutate: (child) => {
        const promptGene = child.getGene('systemPrompt');
        if (promptGene) promptGene.value = improved;
      },
    };
  }

  // Ask the AI which specialization weight to raise/lower
  async _proposeSpecializationShift(instance) {
    const spec = instance.genome.getSpecialization();

    const result = await this.inferenceEngine.complete([
      {
        role: 'user',
        content: `Given these AI specialization weights: ${JSON.stringify(spec)}
Suggest which specialization should be increased and which decreased to create a more effective AI agent.
Respond in JSON format: {"increase": "category", "decrease": "category", "reason": "brief reason"}`,
      },
    ], { temperature: 0.3, maxTokens: 128 });

    let suggestion;
    try {
      suggestion = JSON.parse(result.content);
    } catch {
      return null;
    }
    if (!suggestion?.increase || !suggestion?.decrease) return null;
    if (spec[suggestion.increase] === undefined || spec[suggestion.decrease] === undefined) return null;

    return {
      label: 'specialization shift',
      detail: { type: 'specialization_shift', ...suggestion },
      mutate: (child) => {
        const routingGene = child.getGene('specialization');
        if (!routingGene) return;
        routingGene.value[suggestion.increase] = Math.min(1, routingGene.value[suggestion.increase] + 0.05);
        routingGene.value[suggestion.decrease] = Math.max(0, routingGene.value[suggestion.decrease] - 0.05);
      },
    };
  }

  // Get accumulated knowledge (proposals that were actually kept)
  getKnowledge() {
    return [...this.knowledgeBase];
  }
}
