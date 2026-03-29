// iaADN - Code Validator: static analysis for self-programmed code
// Validates code safety before it enters the sandbox or genome

import { IMMUTABLE_RULES } from '../safety/rules.js';

export class CodeValidator {
  constructor() {
    this.maxCodeLength = IMMUTABLE_RULES.maxCodeLength;
    this.forbiddenAPIs = IMMUTABLE_RULES.forbiddenAPIs;
  }

  // Full validation pipeline
  validate(code) {
    const errors = [];

    // 1. Length check
    if (code.length > this.maxCodeLength) {
      errors.push(`Code exceeds max length: ${code.length} > ${this.maxCodeLength}`);
    }

    // 2. Forbidden API checks
    for (const api of this.forbiddenAPIs) {
      if (code.includes(api)) {
        errors.push(`Forbidden API: ${api}`);
      }
    }

    // 3. Dangerous patterns
    const dangerousPatterns = [
      { pattern: /require\s*\(/g, name: 'require()' },
      { pattern: /import\s*\(/g, name: 'dynamic import()' },
      { pattern: /globalThis/g, name: 'globalThis' },
      { pattern: /__proto__/g, name: '__proto__' },
      { pattern: /constructor\s*\[/g, name: 'constructor access' },
      { pattern: /\beval\b/g, name: 'eval' },
      { pattern: /new\s+Function/g, name: 'Function constructor' },
      { pattern: /Reflect\./g, name: 'Reflect API' },
      { pattern: /Proxy\s*\(/g, name: 'Proxy' },
      { pattern: /while\s*\(\s*true\s*\)/g, name: 'infinite while loop' },
      { pattern: /for\s*\(\s*;\s*;\s*\)/g, name: 'infinite for loop' },
      { pattern: /Symbol\./g, name: 'Symbol API' },
      { pattern: /WeakRef/g, name: 'WeakRef' },
      { pattern: /FinalizationRegistry/g, name: 'FinalizationRegistry' },
    ];

    for (const { pattern, name } of dangerousPatterns) {
      if (pattern.test(code)) {
        errors.push(`Dangerous pattern: ${name}`);
      }
    }

    // 4. Check for excessive nesting (potential stack overflow)
    let maxDepth = 0;
    let depth = 0;
    for (const char of code) {
      if (char === '{') depth++;
      if (char === '}') depth--;
      maxDepth = Math.max(maxDepth, depth);
    }
    if (maxDepth > 15) {
      errors.push(`Excessive nesting depth: ${maxDepth}`);
    }

    // 5. Check for string escapes that might bypass detection
    if (code.includes('\\x') || code.includes('\\u{')) {
      // Allow simple unicode but check for obfuscation
      const decoded = code.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16))
      );
      for (const api of this.forbiddenAPIs) {
        if (decoded.includes(api) && !code.includes(api)) {
          errors.push(`Obfuscated forbidden API detected: ${api}`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      stats: {
        length: code.length,
        maxNesting: maxDepth,
        lineCount: code.split('\n').length,
      },
    };
  }
}
