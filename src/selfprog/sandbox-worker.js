// iaADN - Sandbox worker: runs untrusted code in a fresh vm context inside a
// worker thread. The host (src/selfprog/sandbox.js) waits synchronously and
// terminates this thread if it doesn't answer in time — including runaway
// async work, which a vm timeout alone can't stop.

import { workerData } from 'worker_threads';
import { createContext, runInContext } from 'vm';

const { port, signal } = workerData;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function run({ code, payload, timeout }) {
  const data = JSON.parse(payload);
  const names = Object.keys(data).filter(k => IDENTIFIER.test(k));

  // Nothing from this realm goes in: the only value handed over is a
  // primitive string, and string code generation is off for the context.
  const vmContext = createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
  });
  vmContext.__payload = payload;

  const wrapped = `(function () {
    var __logs = [];
    var __data = JSON.parse(__payload);
    var __console = { log: function () {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) parts.push(String(arguments[i]));
      __logs.push(parts.join(' '));
    } };
    function __msg(e) {
      try { return String(e && e.message !== undefined ? e.message : e); } catch (_) { return 'Unknown error'; }
    }
    try {
      var __r = (function (${['console', ...names].join(', ')}) {
        'use strict';
        ${code}
      })(__console${names.map(n => `, __data[${JSON.stringify(n)}]`).join('')});
      return JSON.stringify({ ok: true, undef: __r === undefined, result: __r === undefined ? null : __r, logs: __logs });
    } catch (e) {
      try { return JSON.stringify({ ok: false, error: __msg(e), logs: __logs }); }
      catch (_) { return '{"ok":false,"error":"Unserializable error","logs":[]}'; }
    }
  })()`;

  try {
    const raw = runInContext(wrapped, vmContext, { timeout, displayErrors: false });
    return typeof raw === 'string' ? raw : '{"ok":false,"error":"Invalid sandbox output","logs":[]}';
  } catch (err) {
    return JSON.stringify({ ok: false, error: String(err?.message || 'Execution failed'), logs: [] });
  }
}

port.on('message', (msg) => {
  const raw = run(msg);
  // Reply only once any promise jobs the code queued have drained — if they
  // never do, no reply comes and the host kills this thread on timeout.
  setImmediate(() => {
    port.postMessage({ id: msg.id, raw });
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
  });
});
