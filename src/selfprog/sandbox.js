// iaADN - Sandbox: isolated code execution environment
// Self-programmed and model-written code runs here.
//
// Layers, each independent of the others:
// - A fresh vm context that never receives a host object (any host object
//   exposes the host Function via `.constructor`, which reaches `process`).
//   Data goes in and out as JSON strings only.
// - String code generation (eval / Function(...)) disabled for the context.
// - The context lives in a worker thread with a heap limit. The host waits
//   synchronously and terminates the thread if it doesn't answer in time,
//   which also stops runaway promise jobs that a vm timeout can't.
// (vm's microtaskMode:'afterEvaluate' is deliberately not used: a timeout
// during its microtask checkpoint crashes the whole Node process.)

import { Worker, MessageChannel, receiveMessageOnPort } from 'worker_threads';
import { IMMUTABLE_RULES } from '../safety/rules.js';

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const WORKER_URL = new URL('./sandbox-worker.js', import.meta.url);
const BOOT_GRACE_MS = 3000;

// One worker shared by every Sandbox instance; replaced whenever it's killed.
let shared = null;
let nextId = 1;

function spawnWorker(memoryLimit) {
  const { port1, port2 } = new MessageChannel();
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(WORKER_URL, {
    workerData: { port: port2, signal },
    transferList: [port2],
    resourceLimits: {
      maxOldGenerationSizeMb: Math.max(16, Math.floor(memoryLimit / (1024 * 1024))),
      maxYoungGenerationSizeMb: 8,
    },
  });
  worker.on('error', () => { if (shared?.worker === worker) shared = null; });
  worker.on('exit', () => { if (shared?.worker === worker) shared = null; });
  worker.unref();
  port1.unref();
  return { worker, port: port1, signal, fresh: true };
}

function killWorker(w) {
  if (shared === w) shared = null;
  w.port.close();
  w.worker.terminate().catch(() => {});
}

export class Sandbox {
  constructor({ timeout, memoryLimit } = {}) {
    this.timeout = timeout || IMMUTABLE_RULES.sandboxTimeout;
    this.memoryLimit = memoryLimit || IMMUTABLE_RULES.sandboxMemoryLimit;
  }

  // Execute code in isolation. `context` values must be JSON-serializable
  // data; they're exposed to the code as variables (e.g. `input`).
  execute(code, context = {}) {
    const payload = {};
    for (const [name, value] of Object.entries(context)) {
      if (IDENTIFIER.test(name) && value !== undefined) payload[name] = value;
    }

    let payloadJson;
    try {
      payloadJson = JSON.stringify(payload);
    } catch {
      return { success: false, result: undefined, error: 'Context is not serializable', logs: [] };
    }

    const w = shared || (shared = spawnWorker(this.memoryLimit));
    const id = nextId++;
    Atomics.store(w.signal, 0, 0);
    w.port.postMessage({ id, code: String(code), payload: payloadJson, timeout: this.timeout });

    const budget = this.timeout + 500 + (w.fresh ? BOOT_GRACE_MS : 0);
    w.fresh = false;
    const deadline = Date.now() + budget;

    let reply = null;
    while (!reply) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || Atomics.wait(w.signal, 0, 0, remaining) === 'timed-out') {
        killWorker(w);
        return { success: false, result: undefined, error: `Script execution timed out after ${this.timeout}ms (or exceeded its memory limit)`, logs: [] };
      }
      let msg;
      while ((msg = receiveMessageOnPort(w.port))) {
        if (msg.message.id === id) reply = msg.message;
      }
      if (!reply) {
        if (!shared) {
          return { success: false, result: undefined, error: 'Sandbox worker died', logs: [] };
        }
        Atomics.store(w.signal, 0, 0);
      }
    }

    const out = JSON.parse(reply.raw);
    return {
      success: out.ok,
      result: out.ok && !out.undef ? out.result : undefined,
      error: out.ok ? null : out.error,
      logs: out.logs,
    };
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
