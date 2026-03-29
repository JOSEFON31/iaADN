// iaADN - Model Registry: manages local GGUF model files

import { readdirSync, statSync, existsSync, mkdirSync } from 'fs';
import { resolve, basename, extname } from 'path';
import { getConfig } from '../config.js';

export class ModelRegistry {
  constructor(modelsDir) {
    this.modelsDir = modelsDir || getConfig().paths.models;
    if (!existsSync(this.modelsDir)) {
      mkdirSync(this.modelsDir, { recursive: true });
    }
  }

  // List all available models
  listModels() {
    const files = readdirSync(this.modelsDir);
    return files
      .filter(f => extname(f).toLowerCase() === '.gguf')
      .map(f => {
        const fullPath = resolve(this.modelsDir, f);
        const stats = statSync(fullPath);
        return {
          name: basename(f, '.gguf'),
          file: f,
          path: fullPath,
          sizeBytes: stats.size,
          sizeMB: Math.round(stats.size / (1024 * 1024)),
          modified: stats.mtime,
        };
      })
      .sort((a, b) => b.modified - a.modified);
  }

  // Get a specific model by name
  getModel(name) {
    const models = this.listModels();
    return models.find(m => m.name === name || m.file === name) || null;
  }

  // Get the best available model (largest = most capable, as a heuristic)
  getBestModel() {
    const models = this.listModels();
    if (models.length === 0) return null;
    return models.sort((a, b) => b.sizeBytes - a.sizeBytes)[0];
  }

  // Get the smallest available model (fastest inference)
  getFastestModel() {
    const models = this.listModels();
    if (models.length === 0) return null;
    return models.sort((a, b) => a.sizeBytes - b.sizeBytes)[0];
  }

  // Check if any models are available
  hasModels() {
    return this.listModels().length > 0;
  }
}
