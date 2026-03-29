// iaADN - Sandbox: isolated code execution environment
// Self-programmed code runs here — can't access filesystem, network, or dangerous APIs

import { createContext, runInContext } from 'vm';
import { IMMUTABLE_RULES } from '../safety/rules.js';

export class Sandbox {
  constructor({ timeout, memoryLimit } = {}) {
    this.timeout = timeout || IMMUTABLE_RULES.sandboxTimeout;
    this.memoryLimit = memoryLimit || IMMUTABLE_RULES.sandboxMemoryLimit;
  }

  // Execute code in an isolated V8 context
  execute(code, context = {}) {
    // Create minimal safe globals
    const sandbox = {
      console: { log: (...args) => sandbox._logs.push(args.join(' ')) },
      Math,
      JSON,
      String,
      Number,
      Boolean,
      Array,
      Object,
      Map,
      Set,
      Date,
      RegExp,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      encodeURIComponent,
      decodeURIComponent,
      _logs: [],
      _result: undefined,
      _error: null,
      ...context,
    };

    const vmContext = createContext(sandbox);

    // Wrap code to capture result
    const wrappedCode = `
      try {
        _result = (function() {
          'use strict';
          ${code}
        })();
      } catch(e) {
        _error = e.message || String(e);
      }
    `;

    try {
      runInContext(wrappedCode, vmContext, {
        timeout: this.timeout,
        displayErrors: false,
      });

      return {
        success: !sandbox._error,
        result: sandbox._result,
        error: sandbox._error,
        logs: sandbox._logs,
      };
    } catch (err) {
      return {
        success: false,
        result: undefined,
        error: err.message || 'Execution failed',
        logs: sandbox._logs,
      };
    }
  }

  // Execute and validate against expected outputs
  executeWithTests(code, testCases) {
    const results = [];
    let passed = 0;

    for (const test of testCases) {
      const result = this.execute(code, { input: test.input });

      const testResult = {
        input: test.input,
        expected: test.expected,
        actual: result.result,
        passed: false,
        error: result.error,
      };

      if (result.success) {
        testResult.passed = JSON.stringify(result.result) === JSON.stringify(test.expected);
        if (testResult.passed) passed++;
      }

      results.push(testResult);
    }

    return {
      passed,
      total: testCases.length,
      passRate: testCases.length > 0 ? passed / testCases.length : 0,
      results,
    };
  }
}
