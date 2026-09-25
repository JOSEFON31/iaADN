// iaADN - Code Validator: static analysis for self-programmed code
// Validates code safety before it enters the sandbox or genome. The sandbox
// (src/selfprog/sandbox.js) is the real boundary; this is an independent
// first layer, so a bypass of one still has to get past the other.

import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import { IMMUTABLE_RULES } from '../safety/rules.js';

export const FORBIDDEN_IDENTIFIERS = Object.freeze([
  'process', 'globalThis', 'global', 'require', 'module', 'exports', 'eval', 'Function',
  'Reflect', 'Proxy', 'WeakRef', 'FinalizationRegistry', 'SharedArrayBuffer', 'Atomics',
  'WebAssembly', 'getBuiltinModule', 'Buffer', 'fetch', 'setTimeout', 'setInterval', 'queueMicrotask',
]);

export const FORBIDDEN_PROPERTIES = Object.freeze([
  'constructor', '__proto__', 'prototype', '__defineGetter__', '__defineSetter__',
  '__lookupGetter__', '__lookupSetter__', 'caller', 'callee', 'mainModule', 'binding', 'dlopen',
]);

// Parse `code` and return the list of AST-level violations. `asFunctionBody`
// allows top-level `return` (sandbox tools); source-edit patches pass false.
export function astViolations(code, { asFunctionBody = true } = {}) {
  let ast;
  try {
    ast = acorn.parse(code, {
      ecmaVersion: 'latest',
      sourceType: asFunctionBody ? 'script' : 'module',
      allowReturnOutsideFunction: asFunctionBody,
    });
  } catch (err) {
    return [`Syntax error: ${err.message}`];
  }

  const errors = new Set();
  const propName = (node) => {
    if (!node.computed && node.property.type === 'Identifier') return node.property.name;
    if (node.computed && node.property.type === 'Literal') return String(node.property.value);
    return null;
  };

  walk.full(ast, (node) => {
    switch (node.type) {
      case 'Identifier':
        if (FORBIDDEN_IDENTIFIERS.includes(node.name)) errors.add(`Forbidden identifier: ${node.name}`);
        break;
      case 'MemberExpression': {
        const name = propName(node);
        if (name && FORBIDDEN_PROPERTIES.includes(name)) errors.add(`Forbidden property access: ${name}`);
        break;
      }
      case 'Property':
      case 'MethodDefinition':
        if (!node.computed && node.key?.type === 'Identifier' && node.key.name === '__proto__') {
          errors.add('Forbidden property access: __proto__');
        }
        break;
      case 'ImportExpression':
        errors.add('Dangerous pattern: dynamic import()');
        break;
      case 'ImportDeclaration':
        if (asFunctionBody) errors.add('Dangerous pattern: import');
        break;
      case 'MetaProperty':
        errors.add('Dangerous pattern: import.meta / new.target');
        break;
      case 'WithStatement':
        errors.add('Dangerous pattern: with');
        break;
    }
  });

  return [...errors];
}

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

    // 2. AST analysis
    errors.push(...astViolations(code));

    // 3. Textual checks — kept as an extra layer on top of the AST
    for (const api of this.forbiddenAPIs) {
      if (code.includes(api)) {
        errors.push(`Forbidden API: ${api}`);
      }
    }

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
    if (code.includes('\\x') || code.includes('\\u')) {
      const decoded = code
        .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/\\u\{?([0-9a-fA-F]{4,6})\}?/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
      const suspicious = [...this.forbiddenAPIs, ...FORBIDDEN_PROPERTIES, 'process'];
      for (const api of suspicious) {
        if (decoded.includes(api) && !code.includes(api)) {
          errors.push(`Obfuscated forbidden API detected: ${api}`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors: [...new Set(errors)],
      stats: {
        length: code.length,
        maxNesting: maxDepth,
        lineCount: code.split('\n').length,
      },
    };
  }
}
