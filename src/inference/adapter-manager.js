// iaADN - Adapter Manager: manages LoRA adapters for model specialization
// Adapters are lightweight model modifications that define AI personality/skills

import { readdirSync, statSync, existsSync, mkdirSync } from 'fs';
import { resolve, basename, extname } from 'path';
import { getConfig } from '../config.js';

export class AdapterManager {
  constructor(adaptersDir) {
    this.adaptersDir = adaptersDir || getConfig().paths.adapters;
    this.activeAdapters = new Map(); // instanceId -> adapter path
    if (!existsSync(this.adaptersDir)) {
      mkdirSync(this.adaptersDir, { recursive: true });
    }
  }

  // List available adapters
  listAdapters() {
    if (!existsSync(this.adaptersDir)) return [];
    const files = readdirSync(this.adaptersDir);
    return files
      .filter(f => extname(f).toLowerCase() === '.bin' || extname(f).toLowerCase() === '.gguf')
      .map(f => {
        const fullPath = resolve(this.adaptersDir, f);
        const stats = statSync(fullPath);
        return {
          name: basename(f, extname(f)),
          file: f,
          path: fullPath,
          sizeBytes: stats.size,
          modified: stats.mtime,
        };
      });
  }

  // Assign an adapter to an instance
  assignAdapter(instanceId, adapterPath) {
    this.activeAdapters.set(instanceId, adapterPath);
  }

  // Get the adapter assigned to an instance
  getAdapter(instanceId) {
    return this.activeAdapters.get(instanceId) || null;
  }

  // Remove adapter assignment
  removeAdapter(instanceId) {
    this.activeAdapters.delete(instanceId);
  }

  // Check if an adapter file exists
  hasAdapter(name) {
    return this.listAdapters().some(a => a.name === name);
  }
}
