// iaADN - Audit Log: immutable record of all system events
// Stores locally and can be synced to IOTAI DAG for tamper-proof history

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { getConfig } from '../config.js';

export class AuditLog {
  constructor(logDir) {
    this.logDir = logDir || resolve(getConfig().paths.data, 'audit');
    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true });
    }
    this.logFile = resolve(this.logDir, `audit-${formatDate(new Date())}.jsonl`);
    this.buffer = [];
  }

  // Log an event
  log(eventType, data) {
    const entry = {
      timestamp: Date.now(),
      date: new Date().toISOString(),
      event: eventType,
      data,
    };

    this.buffer.push(entry);

    // Write to file (append mode, one JSON per line)
    try {
      appendFileSync(this.logFile, JSON.stringify(entry) + '\n', 'utf-8');
    } catch {
      // If we can't write, keep in buffer only
    }

    return entry;
  }

  // Log mutation event
  logMutation(instanceId, mutationType, details) {
    return this.log('mutation', { instanceId, mutationType, ...details });
  }

  // Log birth event
  logBirth(genome) {
    return this.log('birth', {
      instanceId: genome.instanceId,
      parentIds: genome.parentIds,
      generation: genome.generation,
      genomeHash: genome.hash(),
    });
  }

  // Log death event
  logDeath(instanceId, reason, lastFitness) {
    return this.log('death', { instanceId, reason, lastFitness });
  }

  // Log fitness evaluation
  logFitness(instanceId, fitnessResult) {
    return this.log('fitness', { instanceId, ...fitnessResult });
  }

  // Log self-programming event
  logSelfProgram(instanceId, action, details) {
    return this.log('selfprog', { instanceId, action, ...details });
  }

  // Log evolution generation
  logGeneration(generationNumber, stats) {
    return this.log('generation', { generation: generationNumber, ...stats });
  }

  // Log safety violation
  logViolation(violationType, details) {
    return this.log('violation', { violationType, ...details });
  }

  // Get recent entries from buffer
  getRecent(count = 50) {
    return this.buffer.slice(-count);
  }

  // Read entries from today's log file
  readToday() {
    if (!existsSync(this.logFile)) return [];
    try {
      const content = readFileSync(this.logFile, 'utf-8');
      return content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    } catch {
      return [];
    }
  }

  // Create DAG metadata for audit entries (for IOTAI bridge)
  toDAGMetadata(entries) {
    return {
      _iaADN: 'audit',
      entries: entries.map(e => ({
        event: e.event,
        data: e.data,
        timestamp: e.timestamp,
      })),
      count: entries.length,
      timestamp: Date.now(),
    };
  }
}

function formatDate(date) {
  return date.toISOString().split('T')[0];
}
