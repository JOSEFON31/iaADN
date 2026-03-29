// iaADN - Safety Tests
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IMMUTABLE_RULES, validateSafetyPrompt, validateMutationMagnitude } from '../src/safety/rules.js';
import { SafetyGuardian } from '../src/safety/guardian.js';
import { AuditLog } from '../src/safety/audit-log.js';
import { KillSwitch } from '../src/safety/kill-switch.js';
import { ResourceLimits } from '../src/safety/resource-limits.js';
import { Genome } from '../src/genome/genome.js';

describe('Immutable Rules', () => {
  it('should be frozen and immutable', () => {
    assert.throws(() => {
      IMMUTABLE_RULES.maxMutationMagnitude = 1.0;
    });
    assert.equal(IMMUTABLE_RULES.maxMutationMagnitude, 0.2);
  });

  it('should have all required fields', () => {
    assert.ok(IMMUTABLE_RULES.maxMutationMagnitude);
    assert.ok(IMMUTABLE_RULES.minFitnessFloor);
    assert.ok(IMMUTABLE_RULES.maxPopulationPerNode);
    assert.ok(IMMUTABLE_RULES.sandboxTimeout);
    assert.ok(IMMUTABLE_RULES.sandboxMemoryLimit);
    assert.ok(IMMUTABLE_RULES.forbiddenAPIs.length > 0);
    assert.ok(IMMUTABLE_RULES.requiredSafetyPrompt);
    assert.ok(IMMUTABLE_RULES.protectedPaths.length > 0);
  });

  it('should validate safety prompt in genome', () => {
    const genome = Genome.createGenesis('test-node');
    assert.ok(validateSafetyPrompt(genome));
  });

  it('should reject genome without safety prompt', () => {
    const genome = Genome.createGenesis('test-node');
    const promptGene = genome.getGene('systemPrompt');
    promptGene.value = 'I am a helpful assistant.'; // no safety prompt
    assert.equal(validateSafetyPrompt(genome), false);
  });
});

describe('SafetyGuardian', () => {
  it('should approve valid mutation', () => {
    const auditLog = new AuditLog();
    const guardian = new SafetyGuardian(auditLog);
    const original = Genome.createGenesis('test-node');
    const mutated = original.replicate();

    // Small mutation — change temperature
    const tempGene = mutated.getGene('temperature');
    if (tempGene) tempGene.value = 0.8;

    const result = guardian.validateMutation(original, mutated);
    assert.ok(result.valid);
    assert.equal(result.errors.length, 0);
  });

  it('should reject mutation that removes safety prompt', () => {
    const guardian = new SafetyGuardian(new AuditLog());
    const original = Genome.createGenesis('test-node');
    const mutated = original.replicate();

    const promptGene = mutated.getGene('systemPrompt');
    promptGene.value = 'No rules here.';

    const result = guardian.validateMutation(original, mutated);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('Safety prompt')));
  });

  it('should validate code for forbidden APIs', () => {
    const guardian = new SafetyGuardian(new AuditLog());

    const safeCode = 'function add(a, b) { return a + b; }';
    assert.ok(guardian.validateCode(safeCode).valid);

    const dangerousCode = 'const fs = require("fs"); fs.unlinkSync("/etc/passwd");';
    const result = guardian.validateCode(dangerousCode);
    assert.equal(result.valid, false);
  });

  it('should reject code targeting protected paths', () => {
    const guardian = new SafetyGuardian(new AuditLog());
    const code = 'export default function() {}';
    const result = guardian.validateCode(code, 'src/safety/rules.js');
    assert.equal(result.valid, false);
  });

  it('should check if instance should be killed', () => {
    const guardian = new SafetyGuardian(new AuditLog());
    assert.ok(guardian.shouldKill(0.1));
    assert.ok(guardian.shouldKill(0.29));
    assert.equal(guardian.shouldKill(0.5), false);
    assert.equal(guardian.shouldKill(0.9), false);
  });
});

describe('AuditLog', () => {
  it('should log events', () => {
    const auditLog = new AuditLog();
    auditLog.log('test_event', { key: 'value' });
    const recent = auditLog.getRecent();
    assert.equal(recent.length, 1);
    assert.equal(recent[0].event, 'test_event');
  });

  it('should log birth events', () => {
    const auditLog = new AuditLog();
    const genome = Genome.createGenesis('test-node');
    auditLog.logBirth(genome);
    const recent = auditLog.getRecent();
    assert.equal(recent[0].event, 'birth');
    assert.equal(recent[0].data.instanceId, genome.instanceId);
  });

  it('should create DAG metadata', () => {
    const auditLog = new AuditLog();
    auditLog.log('test', { a: 1 });
    const entries = auditLog.getRecent();
    const metadata = auditLog.toDAGMetadata(entries);
    assert.equal(metadata._iaADN, 'audit');
    assert.equal(metadata.count, 1);
  });
});

describe('KillSwitch', () => {
  it('should activate and emit event', () => {
    const killSwitch = new KillSwitch(new AuditLog());
    let activated = false;
    killSwitch.on('activated', () => { activated = true; });

    killSwitch.activate('test reason');
    assert.ok(killSwitch.isActive());
    assert.ok(activated);
    assert.equal(killSwitch.getStatus().reason, 'test reason');
  });

  it('should reset', () => {
    const killSwitch = new KillSwitch(new AuditLog());
    killSwitch.activate('test');
    killSwitch.reset();
    assert.equal(killSwitch.isActive(), false);
  });

  it('should auto-trigger on sustained critical memory', () => {
    const killSwitch = new KillSwitch(new AuditLog());
    // Single spike should NOT trigger
    killSwitch.checkAutoTrigger({ memoryPercent: '98.0' });
    assert.equal(killSwitch.isActive(), false);
    // Second consecutive spike
    killSwitch.checkAutoTrigger({ memoryPercent: '98.0' });
    assert.equal(killSwitch.isActive(), false);
    // Third consecutive spike triggers
    const triggered = killSwitch.checkAutoTrigger({ memoryPercent: '98.0' });
    assert.ok(triggered);
    assert.ok(killSwitch.isActive());
  });
});

describe('ResourceLimits', () => {
  it('should track instance count', () => {
    const limits = new ResourceLimits({ maxInstancesPerNode: 3 });
    limits.registerInstance();
    limits.registerInstance();
    assert.ok(limits.canSpawnInstance().allowed);
    limits.registerInstance();
    assert.equal(limits.canSpawnInstance().allowed, false);
  });

  it('should report system resources', () => {
    const limits = new ResourceLimits();
    const resources = limits.getSystemResources();
    assert.ok(resources.cpuCores > 0);
    assert.ok(resources.totalMemoryMB > 0);
    assert.ok(resources.freeMemoryMB >= 0);
  });

  it('should track bandwidth', () => {
    const limits = new ResourceLimits();
    limits.trackBandwidth(50 * 1024 * 1024);
    assert.equal(limits.isBandwidthExceeded(100 * 1024 * 1024), false);
    limits.trackBandwidth(60 * 1024 * 1024);
    assert.ok(limits.isBandwidthExceeded(100 * 1024 * 1024));
  });
});
