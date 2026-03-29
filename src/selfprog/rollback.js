// iaADN - Rollback Manager: snapshot and recovery for safe self-modification
// Creates snapshots before mutations, allows rollback if things go wrong

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'fs';
import { resolve } from 'path';
import { getConfig } from '../config.js';

export class RollbackManager {
  constructor(snapshotDir) {
    this.snapshotDir = snapshotDir || getConfig().paths.snapshots;
    if (!existsSync(this.snapshotDir)) {
      mkdirSync(this.snapshotDir, { recursive: true });
    }
  }

  // Create a snapshot before a mutation/self-programming change
  createSnapshot(instanceId, genome) {
    const snapshotId = `${instanceId}_${Date.now()}`;
    const dir = resolve(this.snapshotDir, instanceId);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const filePath = resolve(dir, `${snapshotId}.json`);
    const snapshot = {
      snapshotId,
      instanceId,
      genome: genome.toJSON(),
      timestamp: Date.now(),
    };

    writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf-8');
    return snapshotId;
  }

  // Rollback to a specific snapshot
  rollback(instanceId, snapshotId) {
    const dir = resolve(this.snapshotDir, instanceId);
    const filePath = resolve(dir, `${snapshotId}.json`);

    if (!existsSync(filePath)) {
      throw new Error(`Snapshot not found: ${snapshotId}`);
    }

    const snapshot = JSON.parse(readFileSync(filePath, 'utf-8'));
    return snapshot;
  }

  // Get the most recent snapshot for an instance
  getLatestSnapshot(instanceId) {
    const dir = resolve(this.snapshotDir, instanceId);
    if (!existsSync(dir)) return null;

    const files = readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse();

    if (files.length === 0) return null;

    const snapshot = JSON.parse(readFileSync(resolve(dir, files[0]), 'utf-8'));
    return snapshot;
  }

  // List snapshots for an instance
  listSnapshots(instanceId) {
    const dir = resolve(this.snapshotDir, instanceId);
    if (!existsSync(dir)) return [];

    return readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const data = JSON.parse(readFileSync(resolve(dir, f), 'utf-8'));
        return {
          snapshotId: data.snapshotId,
          timestamp: data.timestamp,
          file: f,
        };
      })
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  // Prune old snapshots (keep only the last N)
  prune(instanceId, keepCount = 5) {
    const snapshots = this.listSnapshots(instanceId);
    const toDelete = snapshots.slice(keepCount);
    const dir = resolve(this.snapshotDir, instanceId);

    for (const snap of toDelete) {
      const filePath = resolve(dir, snap.file);
      if (existsSync(filePath)) {
        rmSync(filePath);
      }
    }

    return toDelete.length;
  }
}
