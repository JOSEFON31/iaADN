// iaADN - Code Generator: the AI writes its own code
// Uses local inference to generate, validate, and test new modules

import { CodeValidator } from './code-validator.js';
import { Sandbox } from './sandbox.js';
import { Gene, GENE_TYPES } from '../genome/gene.js';
import { createHash } from 'crypto';

export class CodeGenerator {
  constructor({ inferenceEngine, auditLog }) {
    this.inferenceEngine = inferenceEngine;
    this.auditLog = auditLog;
    this.validator = new CodeValidator();
    this.sandbox = new Sandbox();
    this.maxAttempts = 3;
  }

  // Generate a new code module from a specification
  async generateModule(specification, testCases = []) {
    const prompt = `You are a code generator. Write a JavaScript function that:
${specification}

Rules:
- Write ONLY the function body (no imports, no require, no exports)
- The function receives input via the 'input' variable
- Return the result (don't use console.log)
- Use only: Math, JSON, String, Number, Array, Object, Map, Set, Date, RegExp
- Do NOT use: fs, net, require, import, eval, Function, process, globalThis
- Keep the code under 5000 characters
- Make it efficient and correct

Respond with ONLY the code, no explanations.`;

    let bestCode = null;
    let bestPassRate = 0;

    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      try {
        const result = await this.inferenceEngine.complete(
          [{ role: 'user', content: prompt }],
          { temperature: 0.3 + attempt * 0.2, maxTokens: 1024 }
        );

        let code = this._extractCode(result.content);

        // Validate safety
        const validation = this.validator.validate(code);
        if (!validation.valid) {
          if (this.auditLog) {
            this.auditLog.logSelfProgram(null, 'code_rejected', {
              attempt,
              errors: validation.errors,
            });
          }
          continue;
        }

        // Test in sandbox
        if (testCases.length > 0) {
          const testResult = this.sandbox.executeWithTests(code, testCases);
          if (testResult.passRate > bestPassRate) {
            bestCode = code;
            bestPassRate = testResult.passRate;
          }

          if (testResult.passRate === 1.0) break; // perfect score, stop trying
        } else {
          // No tests — just validate it runs without error
          const execResult = this.sandbox.execute(code);
          if (execResult.success) {
            bestCode = code;
            bestPassRate = 1.0;
            break;
          }
        }
      } catch {
        // Inference failed, try again
      }
    }

    if (!bestCode) {
      return { success: false, reason: 'all_attempts_failed' };
    }

    // Create a code gene from the successful code
    const codeHash = createHash('sha256').update(bestCode).digest('hex').slice(0, 16);
    const gene = new Gene({
      type: GENE_TYPES.CODE,
      name: `module_${codeHash}`,
      value: { hash: codeHash, code: bestCode, spec: specification },
    });

    if (this.auditLog) {
      this.auditLog.logSelfProgram(null, 'code_generated', {
        hash: codeHash,
        passRate: bestPassRate,
        codeLength: bestCode.length,
      });
    }

    return {
      success: true,
      gene,
      code: bestCode,
      hash: codeHash,
      passRate: bestPassRate,
    };
  }

  // Optimize an existing code module
  async optimizeModule(existingCode, specification, testCases = []) {
    const prompt = `You are a code optimizer. Here is existing code:

\`\`\`javascript
${existingCode}
\`\`\`

Specification: ${specification}

Optimize this code for:
1. Speed (fewer operations)
2. Memory efficiency
3. Correctness

Rules:
- Write ONLY the optimized function body
- Do NOT use: fs, net, require, import, eval, Function, process, globalThis
- Keep the same input/output interface

Respond with ONLY the optimized code, no explanations.`;

    const result = await this.generateModuleFromPrompt(prompt, testCases);
    return result;
  }

  async generateModuleFromPrompt(prompt, testCases) {
    try {
      const result = await this.inferenceEngine.complete(
        [{ role: 'user', content: prompt }],
        { temperature: 0.2, maxTokens: 1024 }
      );

      const code = this._extractCode(result.content);
      const validation = this.validator.validate(code);
      if (!validation.valid) return { success: false, reason: 'validation_failed', errors: validation.errors };

      if (testCases.length > 0) {
        const testResult = this.sandbox.executeWithTests(code, testCases);
        if (testResult.passRate < 1.0) return { success: false, reason: 'tests_failed', passRate: testResult.passRate };
      }

      const codeHash = createHash('sha256').update(code).digest('hex').slice(0, 16);
      return { success: true, code, hash: codeHash };
    } catch (err) {
      return { success: false, reason: err.message };
    }
  }

  // Extract code from AI response (strip markdown fences, etc.)
  _extractCode(response) {
    let code = response.trim();

    // Remove markdown code fences
    const fenceMatch = code.match(/```(?:javascript|js)?\n([\s\S]*?)```/);
    if (fenceMatch) {
      code = fenceMatch[1];
    }

    // Remove leading/trailing whitespace
    return code.trim();
  }
}
