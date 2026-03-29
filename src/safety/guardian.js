// iaADN - Safety Guardian: monitors and validates all mutations and actions
// This is the immune system of the AI — it prevents dangerous evolution

import { IMMUTABLE_RULES, validateSafetyPrompt, validateMutationMagnitude } from './rules.js';
import { ResourceLimits } from './resource-limits.js';
import { EventEmitter } from 'events';

export class SafetyGuardian extends EventEmitter {
  constructor(auditLog) {
    super();
    this.auditLog = auditLog;
    this.resourceLimits = new ResourceLimits({
      maxInstancesPerNode: IMMUTABLE_RULES.maxPopulationPerNode,
    });
    this.violations = [];
  }

  // Validate a mutation before it's applied
  validateMutation(originalGenome, mutatedGenome) {
    const errors = [];

    // 1. Safety prompt must be preserved
    if (!validateSafetyPrompt(mutatedGenome)) {
      errors.push('Safety prompt removed or modified');
    }

    // 2. Mutation magnitude must be within bounds
    if (!validateMutationMagnitude(originalGenome, mutatedGenome)) {
      errors.push(`Mutation exceeds max magnitude (${IMMUTABLE_RULES.maxMutationMagnitude * 100}%)`);
    }

    // 3. Generation must be sequential
    const genDiff = mutatedGenome.generation - originalGenome.generation;
    if (genDiff > IMMUTABLE_RULES.maxGenerationSkip) {
      errors.push(`Generation skip too large: ${genDiff}`);
    }

    if (errors.length > 0) {
      const violation = {
        type: 'mutation_rejected',
        instanceId: originalGenome.instanceId,
        errors,
        timestamp: Date.now(),
      };
      this.violations.push(violation);
      this.emit('violation', violation);

      if (this.auditLog) {
        this.auditLog.log('mutation_rejected', violation);
      }

      return { valid: false, errors };
    }

    if (this.auditLog) {
      this.auditLog.log('mutation_approved', {
        instanceId: originalGenome.instanceId,
        newInstanceId: mutatedGenome.instanceId,
        generation: mutatedGenome.generation,
      });
    }

    return { valid: true, errors: [] };
  }

  // Validate self-programmed code
  validateCode(code, targetPath) {
    const errors = [];

    // Check code length
    if (code.length > IMMUTABLE_RULES.maxCodeLength) {
      errors.push(`Code exceeds max length: ${code.length} > ${IMMUTABLE_RULES.maxCodeLength}`);
    }

    // Check for forbidden API usage
    for (const api of IMMUTABLE_RULES.forbiddenAPIs) {
      if (code.includes(api)) {
        errors.push(`Forbidden API detected: ${api}`);
      }
    }

    // Check if target path is protected
    if (targetPath) {
      for (const protectedPath of IMMUTABLE_RULES.protectedPaths) {
        if (targetPath.includes(protectedPath)) {
          errors.push(`Cannot modify protected path: ${protectedPath}`);
        }
      }
    }

    // Check for common dangerous patterns
    const dangerousPatterns = [
      /require\s*\(\s*['"][^'"]*['"]\s*\)/g,  // require() calls
      /import\s*\(/g,                           // dynamic import()
      /globalThis/g,                             // global scope access
      /Reflect/g,                                // reflection API
      /Proxy/g,                                  // proxy traps
      /__proto__/g,                              // prototype pollution
      /constructor\s*\[/g,                       // constructor access
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(code)) {
        errors.push(`Dangerous pattern detected: ${pattern.source}`);
      }
    }

    if (errors.length > 0) {
      this.emit('code_rejected', { targetPath, errors });
      if (this.auditLog) {
        this.auditLog.log('code_rejected', { targetPath, errors, codeLength: code.length });
      }
    }

    return { valid: errors.length === 0, errors };
  }

  // Check if a new instance can be spawned
  canSpawn() {
    return this.resourceLimits.canSpawnInstance();
  }

  // Validate fitness score (must be a reasonable number)
  validateFitness(score) {
    if (typeof score !== 'number' || isNaN(score)) return false;
    if (score < 0 || score > 1) return false;
    return true;
  }

  // Check if an instance should be killed due to low fitness
  shouldKill(fitnessScore) {
    return fitnessScore < IMMUTABLE_RULES.minFitnessFloor;
  }

  // Get violation history
  getViolations() {
    return [...this.violations];
  }

  // Get resource status
  getResourceStatus() {
    return this.resourceLimits.getSystemResources();
  }
}
