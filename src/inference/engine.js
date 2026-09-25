// iaADN - Inference Engine: abstraction layer for local AI inference
// Supports multiple backends (llama.cpp, etc.)

import { EventEmitter } from 'events';
import { getConfig } from '../config.js';

export class InferenceEngine extends EventEmitter {
  constructor(backend) {
    super();
    this.backend = backend;
    this.ready = false;
    this.stats = {
      totalInferences: 0,
      totalTokens: 0,
      avgTokensPerSec: 0,
    };
  }

  async initialize() {
    await this.backend.load();
    this.ready = true;
    this.emit('ready');
  }

  async complete(messages, options = {}) {
    if (!this.ready) throw new Error('Engine not initialized');

    const config = getConfig().inference;
    const opts = {
      temperature: options.temperature ?? config.defaultTemperature,
      topP: options.topP ?? config.defaultTopP,
      repeatPenalty: options.repeatPenalty ?? config.defaultRepeatPenalty,
      maxTokens: options.maxTokens ?? config.maxTokens,
      systemPrompt: options.systemPrompt || null,
    };

    const start = Date.now();
    const result = await this.backend.complete(messages, opts);
    // Floor elapsed time to 1ms: an instant (mock) backend often completes
    // within the same millisecond, which would make Date.now()-start land on
    // 0 on some calls and >0 on others — pure OS scheduling jitter, not a
    // real timing signal — and that made speed-based fitness nondeterministic
    // even with a fixed RNG seed. Flooring makes it a stable, if maximal, tps.
    const elapsed = Math.max((Date.now() - start) / 1000, 0.001);

    // Update stats
    this.stats.totalInferences++;
    this.stats.totalTokens += result.tokensGenerated || 0;
    if (result.tokensGenerated) {
      const tps = result.tokensGenerated / elapsed;
      this.stats.avgTokensPerSec = (this.stats.avgTokensPerSec * (this.stats.totalInferences - 1) + tps) / this.stats.totalInferences;
    }

    this.emit('inference', {
      elapsed,
      tokens: result.tokensGenerated,
      tokensPerSec: result.tokensGenerated / elapsed,
    });

    return result;
  }

  // Chat-specific inference — uses dedicated context, never blocked by daemon
  async chatComplete(messages, options = {}) {
    if (!this.ready) throw new Error('Engine not initialized');
    if (!this.backend.chatComplete) return this.complete(messages, options);

    const config = getConfig().inference;
    const opts = {
      temperature: options.temperature ?? config.defaultTemperature,
      topP: options.topP ?? config.defaultTopP,
      repeatPenalty: options.repeatPenalty ?? config.defaultRepeatPenalty,
      maxTokens: options.maxTokens ?? config.maxTokens,
      systemPrompt: options.systemPrompt || null,
    };

    const start = Date.now();
    const result = await this.backend.chatComplete(messages, opts);
    const elapsed = Math.max((Date.now() - start) / 1000, 0.001);

    this.stats.totalInferences++;
    this.stats.totalTokens += result.tokensGenerated || 0;

    return result;
  }

  async benchmark(testPrompts = null) {
    const prompts = testPrompts || [
      'What is 2 + 2?',
      'Explain recursion in one sentence.',
      'Write a function that reverses a string.',
    ];

    const results = [];
    for (const prompt of prompts) {
      const start = Date.now();
      const result = await this.complete([{ role: 'user', content: prompt }]);
      const elapsed = (Date.now() - start) / 1000;

      results.push({
        prompt: prompt.slice(0, 50),
        elapsed,
        tokens: result.tokensGenerated || 0,
        tokensPerSec: elapsed > 0 ? ((result.tokensGenerated || 0) / elapsed) : 0,
      });
    }

    const avgTps = results.reduce((sum, r) => sum + r.tokensPerSec, 0) / results.length;
    const avgLatency = results.reduce((sum, r) => sum + r.elapsed, 0) / results.length;

    return { results, avgTokensPerSec: avgTps, avgLatency };
  }

  getStats() {
    return { ...this.stats };
  }

  async shutdown() {
    if (this.backend.unload) {
      await this.backend.unload();
    }
    this.ready = false;
    this.emit('shutdown');
  }
}
