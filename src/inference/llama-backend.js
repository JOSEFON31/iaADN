// iaADN - Llama Backend: local inference via node-llama-cpp
// Supports GGUF models with LoRA adapters

import { getConfig } from '../config.js';

export class LlamaBackend {
  constructor(modelPath) {
    this.modelPath = modelPath;
    this.llama = null;
    this.model = null;
    this.context = null;
    this.loaded = false;
  }

  async load() {
    try {
      // Dynamic import — node-llama-cpp is an optional dependency
      const { getLlama } = await import('node-llama-cpp');
      const config = getConfig().inference;

      this.llama = await getLlama();
      this.model = await this.llama.loadModel({
        modelPath: this.modelPath,
        gpuLayers: config.gpuLayers,
      });
      this.context = await this.model.createContext({
        contextSize: config.contextSize,
        threads: config.threads,
      });
      this.loaded = true;
    } catch (err) {
      // If node-llama-cpp is not installed, fall back to mock mode
      if (err.code === 'ERR_MODULE_NOT_FOUND' || err.message?.includes('Cannot find')) {
        console.warn('[LlamaBackend] node-llama-cpp not available, using mock mode');
        this.loaded = true;
        this.mock = true;
      } else {
        throw err;
      }
    }
  }

  async complete(messages, options) {
    if (!this.loaded) throw new Error('Model not loaded');

    // Mock mode for development/testing without a real model
    if (this.mock) {
      return this._mockComplete(messages, options);
    }

    // Serialize access — only one inference at a time on this context
    if (this._busy) {
      // Wait for current inference to finish
      await new Promise(resolve => {
        const check = () => {
          if (!this._busy) return resolve();
          setTimeout(check, 100);
        };
        check();
      });
    }

    this._busy = true;
    let session;
    try {
      const { LlamaChatSession } = await import('node-llama-cpp');

      // Dispose previous sequence if exists, to free the slot
      if (this._lastSequence) {
        try { this._lastSequence.dispose(); } catch {}
        this._lastSequence = null;
      }

      const sequence = this.context.getSequence();
      this._lastSequence = sequence;

      session = new LlamaChatSession({
        contextSequence: sequence,
        systemPrompt: options.systemPrompt || undefined,
      });

      const userMessage = messages
        .filter(m => m.role === 'user')
        .map(m => m.content)
        .join('\n');

      const response = await session.prompt(userMessage, {
        maxTokens: options.maxTokens || 512,
        temperature: options.temperature,
        topP: options.topP,
        repeatPenalty: options.repeatPenalty ? { penalty: options.repeatPenalty } : undefined,
      });

      const tokensGenerated = Math.ceil(response.length / 4); // rough estimate

      return {
        content: response,
        tokensGenerated,
        model: this.modelPath,
      };
    } finally {
      // Always clean up
      if (session) {
        try { session.dispose(); } catch {}
      }
      if (this._lastSequence) {
        try { this._lastSequence.dispose(); } catch {}
        this._lastSequence = null;
      }
      this._busy = false;
    }
  }

  _mockComplete(messages, options) {
    const userMessage = messages
      .filter(m => m.role === 'user')
      .map(m => m.content)
      .join('\n');

    // Simple mock response for testing
    const mockResponse = `[Mock AI Response] Received: "${userMessage.slice(0, 100)}". Temperature: ${options.temperature}, MaxTokens: ${options.maxTokens}`;

    return {
      content: mockResponse,
      tokensGenerated: Math.ceil(mockResponse.length / 4),
      model: 'mock',
      mock: true,
    };
  }

  async unload() {
    if (this.context) {
      await this.context.dispose?.();
      this.context = null;
    }
    if (this.model) {
      await this.model.dispose?.();
      this.model = null;
    }
    this.loaded = false;
  }
}
