// iaADN - Sandbox & Self-Programming Tests
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Sandbox } from '../src/selfprog/sandbox.js';
import { CodeValidator } from '../src/selfprog/code-validator.js';

describe('Sandbox', () => {
  it('should execute safe code', () => {
    const sandbox = new Sandbox();
    const result = sandbox.execute('return 2 + 2;');
    assert.ok(result.success);
    assert.equal(result.result, 4);
  });

  it('should capture console.log output', () => {
    const sandbox = new Sandbox();
    const result = sandbox.execute('console.log("hello"); return true;');
    assert.ok(result.success);
    assert.ok(result.logs.includes('hello'));
  });

  it('should use context variables', () => {
    const sandbox = new Sandbox();
    const result = sandbox.execute('return input * 2;', { input: 21 });
    assert.ok(result.success);
    assert.equal(result.result, 42);
  });

  it('should timeout on infinite loops', () => {
    const sandbox = new Sandbox({ timeout: 100 });
    const result = sandbox.execute('while(true) {}');
    assert.equal(result.success, false);
    assert.ok(result.error);
  });

  it('should catch runtime errors', () => {
    const sandbox = new Sandbox();
    const result = sandbox.execute('throw new Error("test error");');
    assert.equal(result.success, false);
    assert.equal(result.error, 'test error');
  });

  it('should run test cases', () => {
    const sandbox = new Sandbox();
    const result = sandbox.executeWithTests(
      'return input * input;',
      [
        { input: 2, expected: 4 },
        { input: 3, expected: 9 },
        { input: 5, expected: 25 },
      ]
    );
    assert.equal(result.passed, 3);
    assert.equal(result.total, 3);
    assert.equal(result.passRate, 1.0);
  });

  it('should report failed test cases', () => {
    const sandbox = new Sandbox();
    const result = sandbox.executeWithTests(
      'return input + 1;',
      [
        { input: 2, expected: 3 },  // pass
        { input: 3, expected: 5 },  // fail (returns 4, expected 5)
      ]
    );
    assert.equal(result.passed, 1);
    assert.equal(result.total, 2);
    assert.equal(result.passRate, 0.5);
  });
});

describe('CodeValidator', () => {
  it('should accept safe code', () => {
    const validator = new CodeValidator();
    const result = validator.validate('function add(a, b) { return a + b; }');
    assert.ok(result.valid);
    assert.equal(result.errors.length, 0);
  });

  it('should reject code with require', () => {
    const validator = new CodeValidator();
    const result = validator.validate('const fs = require("fs");');
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('require')));
  });

  it('should reject code with eval', () => {
    const validator = new CodeValidator();
    const result = validator.validate('eval("dangerous code")');
    assert.equal(result.valid, false);
  });

  it('should reject code with forbidden APIs', () => {
    const validator = new CodeValidator();
    assert.equal(validator.validate('process.exit(1)').valid, false);
    assert.equal(validator.validate('child_process.exec("ls")').valid, false);
    assert.equal(validator.validate('new Function("return 1")').valid, false);
  });

  it('should reject infinite loops', () => {
    const validator = new CodeValidator();
    assert.equal(validator.validate('while (true) { }').valid, false);
    assert.equal(validator.validate('for (;;) { }').valid, false);
  });

  it('should reject excessively nested code', () => {
    const validator = new CodeValidator();
    let code = '';
    for (let i = 0; i < 20; i++) code += 'if (true) { ';
    for (let i = 0; i < 20; i++) code += ' }';
    assert.equal(validator.validate(code).valid, false);
  });

  it('should detect obfuscated APIs', () => {
    const validator = new CodeValidator();
    const result = validator.validate('const x = "\\x65\\x76\\x61\\x6c"; // eval');
    // Should detect the hex-escaped "eval"
    assert.equal(result.valid, false);
  });

  it('should report code stats', () => {
    const validator = new CodeValidator();
    const result = validator.validate('function test() {\n  return 1;\n}');
    assert.ok(result.stats.length > 0);
    assert.ok(result.stats.lineCount >= 3);
    assert.ok(result.stats.maxNesting >= 1);
  });
});

// The real escape found in the old sandbox, and variants. Each layer is
// checked on its own: the validator must reject them, and the sandbox must
// not hand back the host's `process` even if the validator were bypassed.
const ESCAPES = [
  "var F = Math.max.constructor; return F('return pro' + 'cess')().pid;",
  "return [].constructor.constructor('return this')().process.pid;",
  "return (() => {}).constructor('return pro' + 'cess')().pid;",
  "return input.constructor.constructor('return pro' + 'cess')().pid;",
  "return console.log.constructor('return pro' + 'cess')().pid;",
  "try { null.x } catch (e) { return e['constr' + 'uctor'].constructor('return pro' + 'cess')().pid; }",
];

describe('Sandbox escape regression', () => {
  for (const code of ESCAPES) {
    it(`sandbox does not leak host process: ${code.slice(0, 50)}`, () => {
      const result = new Sandbox({ timeout: 500 }).execute(code, { input: { a: 1 } });
      assert.equal(typeof result.result, 'undefined');
      assert.equal(result.success, false);
    });
  }

  it('validator rejects the known escapes', () => {
    const validator = new CodeValidator();
    for (const code of ESCAPES) {
      assert.equal(validator.validate(code).valid, false, code);
    }
  });

  it('host globals are not reachable from sandboxed code', () => {
    const result = new Sandbox().execute('return [typeof process, typeof require, typeof globalThis.process].join(",");');
    assert.equal(result.result, 'undefined,undefined,undefined');
  });

  it('input and output are plain data copies', () => {
    const input = { list: [1, 2, 3] };
    const result = new Sandbox().execute('input.list.push(4); return input;', { input });
    assert.deepEqual(result.result, { list: [1, 2, 3, 4] });
    assert.deepEqual(input.list, [1, 2, 3]);
  });

  it('async infinite loops are cut by the timeout', () => {
    const result = new Sandbox({ timeout: 200 }).execute('Promise.resolve().then(() => { for (let i = 0; i >= 0; i++) {} }); return 1;');
    assert.equal(result.success, false);
  });
});
