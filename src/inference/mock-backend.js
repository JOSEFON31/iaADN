// iaADN - Mock Backend: deterministic, instant fake inference
// Used when no real GGUF model is installed, and always used in fast
// simulation mode (`--simulate`) where waiting on a real LLM would make
// running many generations impractical. See docs/PLAN_EVOLUCION.md
// section "0. Cimientos" — "Modo simulación rápida".
//
// Unlike LlamaBackend's own internal mock fallback (a fixed echo string),
// this one answers the default fitness benchmarks correctly most of the
// time — driven by the seeded RNG — so fitness scores actually differ
// between instances instead of being a flat, uninformative constant. That
// gives the evolutionary loop something real to select on even with no
// model loaded.

import { rng } from '../util/rng.js';

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

// Answer a few known benchmark-style prompts correctly with ~70% probability
// (wrong the rest of the time), so instances get a spread of fitness scores.
// Anything else gets a generic canned reply.
function mockAnswer(prompt) {
  const lower = prompt.toLowerCase();
  const correct = rng.random() < 0.7;

  if (/15\s*\+\s*27/.test(lower)) {
    return correct ? '42' : '41';
  }
  if (/capital of france/.test(lower)) {
    return correct ? 'The capital of France is Paris.' : 'The capital of France is Lyon.';
  }

  return `[mock response] ${prompt.slice(0, 60)}`;
}
