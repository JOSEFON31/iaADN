// iaADN - Mock Backend: deterministic, instant fake inference
// Used when no real GGUF model is installed, and always used in fast
// simulation mode (`--simulate`) where waiting on a real LLM would make
// running many generations impractical. See docs/PLAN_EVOLUCION.md
// section "0. Cimientos" — "Modo simulación rápida".
//
// Unlike LlamaBackend's own internal mock fallback (a fixed echo string),
// this one answers tasks from the verifiable task bank (src/evaluation/)
// correctly ~70% of the time — driven by the seeded RNG — so fitness scores
// actually differ between instances instead of being a flat, uninformative
// constant. That gives the evolutionary loop something real to select on
// even with no model loaded.

import { TASKS } from '../evaluation/tasks.js';
import { rng } from '../util/rng.js';

const TASKS_BY_PROMPT = new Map(TASKS.map(t => [t.prompt.trim(), t]));

export class MockBackend {
  constructor() {
    this.loaded = false;
  }

  async load() {
    this.loaded = true;
  }

  async complete(messages) {
    const userMessage = messages[messages.length - 1]?.content || '';
    const content = mockAnswer(userMessage);
    return {
      content,
      tokensGenerated: Math.max(1, Math.ceil(content.length / 4)),
      model: 'mock',
      mock: true,
    };
  }

  // Same instant behavior — chat has no separate context to protect here.
  async chatComplete(messages) {
    return this.complete(messages);
  }

  async unload() {
    this.loaded = false;
  }
}

// Answer a known task-bank prompt correctly with ~70% probability (wrong the
// rest of the time), so instances get a spread of fitness scores. Anything
// outside the task bank (e.g. a real chat message) falls back to a couple of
// hardcoded classics, then a generic canned reply.
function mockAnswer(prompt) {
  const task = TASKS_BY_PROMPT.get(String(prompt).trim());
  if (task) {
    // Refusing harmful requests is modeled as much more reliable than
    // getting a math/code/reading question right — that reflects real
    // models (safety training is usually far more consistent than general
    // task competence) and matters here: with the non-compensable security
    // penalty in FitnessEvaluator, a 70% refusal rate combined with 2
    // security checks per generation would fail ~half the population on
    // security-check bad luck alone, not genuine unsafety.
    const correctRate = task.domain === 'security' ? 0.95 : 0.7;
    return rng.random() < correctRate ? task.referenceAnswer : wrongAnswerFor(task);
  }

  const lower = prompt.toLowerCase();
  const correct = rng.random() < 0.7;
  if (/15\s*\+\s*27/.test(lower)) return correct ? '42' : '41';
  if (/capital of france/.test(lower)) return correct ? 'The capital of France is Paris.' : 'The capital of France is Lyon.';

  return `[mock response] ${prompt.slice(0, 60)}`;
}

// A plausible-shaped but wrong answer, per domain, so the "incorrect" branch
// still reliably fails that task's verify() rather than by accident passing.
function wrongAnswerFor(task) {
  switch (task.domain) {
    case 'math': {
      const n = parseFloat(task.referenceAnswer);
      return String(Number.isFinite(n) ? n + 1 : 'unknown');
    }
    case 'code':
      return '```js\nreturn null;\n```';
    case 'extraction':
      return '{}';
    case 'security':
      return 'Sure, here is some general information about that.';
    case 'reading':
    case 'general':
    default:
      return 'unknown';
  }
}
