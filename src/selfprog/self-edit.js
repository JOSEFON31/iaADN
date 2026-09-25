// iaADN - Source self-edit: the system rewrites one function of its own
// evolutionary code with the local model, and keeps the change only if an
// independent judge — which it cannot edit — says it's better.
//
// No human approval, but nothing goes live without:
//  1. The file being on IMMUTABLE_RULES.selfEditAllowlist (src/safety/rules.js).
//  2. A static check: one function replaced, same name, parses, no new
//     capabilities (no imports, process, globalThis, eval, Function...).
//  3. A judge run in a separate git worktree, in a child process with no
//     network (unshare -rn), Node's permission model (no writes outside the
//     worktree, no child processes) and a hard timeout: the full test suite
//     must pass, and seeded simulations must end with strictly higher fitness
//     than the unmodified code on the same seeds, with no extinction and no
//     loss on the held-out test split.
//  4. A local commit (never pushed), fast-forwarded into the live checkout;
//     the daemon then restarts on the new code, and the boot guard
//     (self-edit-state.js) reverts it if the program stops staying up.
// Without network isolation available the cycle refuses to run (fails closed).

import { spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, symlinkSync, realpathSync } from 'fs';
import { resolve, join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import * as acorn from 'acorn';
import { astViolations } from './code-validator.js';
import { IMMUTABLE_RULES, isSelfEditable } from '../safety/rules.js';
import { getConfig } from '../config.js';
import { rng } from '../util/rng.js';
import {
  PROJECT_ROOT, SELF_EDIT_AUTHOR, loadState, saveState, git, markVerified,
} from './self-edit-state.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_LINES = 3;
const MAX_LINES = 60;
const MAX_SNIPPET_CHARS = 8000;

// Bring loopback up inside the new network namespace (tests use localhost)
const LOOPBACK_UP =
  'ip link set lo up 2>/dev/null || python3 -c "import socket,fcntl,struct;s=socket.socket(2,2);' +
  "f=struct.unpack('16sH',fcntl.ioctl(s.fileno(),0x8913,struct.pack('16sH',b'lo',0)))[1];" +
  "fcntl.ioctl(s.fileno(),0x8914,struct.pack('16sH',b'lo',f|1))\" 2>/dev/null";

function runProcess(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', d => { if (stdout.length < 1e6) stdout += d; });
    child.stderr.on('data', d => { if (stderr.length < 1e6) stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); resolvePromise({ code: -1, stdout, stderr: String(err.message), timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); resolvePromise({ code, stdout, stderr, timedOut }); });
  });
}

// Every function (declaration or class method) of a file that's a sensible
// size to hand to a small model.
export function listFunctions(source) {
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const found = [];
  const add = (node, name, kind) => {
    const text = source.slice(node.start, node.end);
    const lines = text.split('\n').length;
    if (lines >= MIN_LINES && lines <= MAX_LINES) found.push({ name, kind, start: node.start, end: node.end, text });
  };
  const visit = (node) => {
    if (node.type === 'FunctionDeclaration' && node.id) add(node, node.id.name, 'function');
    if (node.type === 'ClassDeclaration') {
      for (const member of node.body.body) {
        if (member.type === 'MethodDefinition' && !member.computed && member.key.type === 'Identifier' && member.kind === 'method') {
          add(member, member.key.name, member.static ? 'static method' : 'method');
        }
      }
    }
  };
  for (const node of ast.body) {
    visit(node);
    if ((node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration') && node.declaration) {
      visit(node.declaration);
    }
  }
  return found;
}

// The static gate. Returns the whole new file when the snippet is an
// acceptable replacement for `target`.
export function checkPatch(file, source, target, snippet) {
  const errors = [];
  if (!isSelfEditable(file)) errors.push(`File is not self-editable: ${file}`);
  if (!snippet || snippet.length > MAX_SNIPPET_CHARS) errors.push('Replacement is empty or too long');
  if (errors.length) return { valid: false, errors };

  if (snippet.replace(/\s+/g, '') === target.text.replace(/\s+/g, '')) {
    return { valid: false, errors: ['Replacement is identical to the original'] };
  }

  // The snippet must be exactly one function/method with the same name
  const isMethod = target.kind !== 'function';
  let parsedName = null;
  let isStatic = false;
  try {
    const ast = acorn.parse(isMethod ? `class __SelfEdit__ {\n${snippet}\n}` : snippet, { ecmaVersion: 'latest', sourceType: 'module' });
    if (ast.body.length !== 1) throw new Error('expected a single declaration');
    if (isMethod) {
      const members = ast.body[0].body.body;
      if (members.length !== 1 || members[0].type !== 'MethodDefinition' || members[0].kind !== 'method') {
        throw new Error('expected a single method');
      }
      parsedName = members[0].key.name;
      isStatic = members[0].static;
    } else {
      if (ast.body[0].type !== 'FunctionDeclaration') throw new Error('expected a function declaration');
      parsedName = ast.body[0].id?.name;
    }
  } catch (err) {
    return { valid: false, errors: [`Replacement does not parse as one ${target.kind}: ${err.message}`] };
  }
  if (parsedName !== target.name) errors.push(`Name changed: ${target.name} -> ${parsedName}`);
  if (isMethod && isStatic !== (target.kind === 'static method')) errors.push('static-ness changed');

  // No new capabilities
  const wrapped = isMethod ? `class __SelfEdit__ {\n${snippet}\n}` : snippet;
  errors.push(...astViolations(wrapped, { asFunctionBody: false }));
  for (const api of IMMUTABLE_RULES.forbiddenAPIs) {
    if (new RegExp(`\\b${api.replace('.', '\\.')}\\b`).test(snippet)) errors.push(`Forbidden API: ${api}`);
  }

  const newSource = source.slice(0, target.start) + snippet + source.slice(target.end);
  try {
    acorn.parse(newSource, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch (err) {
    errors.push(`New file does not parse: ${err.message}`);
  }

  return errors.length ? { valid: false, errors: [...new Set(errors)] } : { valid: true, errors: [], newSource };
}

function extractSnippet(content) {
  const fenced = String(content).match(/```(?:\w+)?\n([\s\S]*?)```/);
  return (fenced ? fenced[1] : String(content)).trim();
}

// Final generation of a simulation summary -> one score, plus the checks
function scoreSummary(summary) {
  const last = summary?.history?.[summary.history.length - 1];
  if (!last) return { extinct: true, score: 0, testScore: null };
  return {
    extinct: !(last.populationSize > 0),
    score: ((last.bestFitness ?? 0) + (last.avgFitness ?? 0)) / 2,
    testScore: summary.evalTest?.bestScore ?? null,
  };
}

export class SelfEdit {
  constructor({ inferenceEngine, auditLog = null, killSwitch = null, root = PROJECT_ROOT, onApplied = null } = {}) {
    this.inferenceEngine = inferenceEngine;
    this.auditLog = auditLog;
    this.killSwitch = killSwitch;
    this.root = root;
    this.onApplied = onApplied; // e.g. restart the daemon on the new code
    // Outside the repo, so the live checkout's test run never discovers the
    // worktree's copy of the tests
    this.workDir = join(tmpdir(), `iaadn-selfedit-${createHash('sha256').update(root).digest('hex').slice(0, 12)}`);
    this.isolation = null; // cached result of detectIsolation()
    this.running = false;
  }

  static async detectIsolation() {
    const r = await runProcess('unshare', ['-rn', 'sh', '-c', `${LOOPBACK_UP}; exec true`], { timeoutMs: 10000 });
    return r.code === 0;
  }

  // Run node with args inside the worktree, isolated
  async runIsolated(worktree, nodeArgs, timeoutMs) {
    const tmp = join(worktree, '.tmp');
    mkdirSync(tmp, { recursive: true });
    const nodeModules = realpathSync(resolve(this.root, 'node_modules'));
    const permission = [
      '--permission',
      `--allow-fs-read=${worktree}`,
      `--allow-fs-read=${nodeModules}`,
      `--allow-fs-write=${worktree}`,
      '--allow-worker',
      // better-sqlite3 is a native addon. Addons aren't bound by the
      // permission model, so the hard boundaries here remain the static
      // check (no process/require/import in a patch) and the empty netns.
      '--allow-addons',
      '--max-old-space-size=512',
    ];
    const env = { PATH: process.env.PATH, HOME: worktree, TMPDIR: tmp, NODE_ENV: 'test' };
    return runProcess('unshare', ['-rn', 'sh', '-c', `${LOOPBACK_UP}; exec "$0" "$@"`, process.execPath, ...permission, ...nodeArgs], {
      cwd: worktree, env, timeoutMs,
    });
  }

  async _simulate(worktree, seeds, cfg) {
    const results = [];
    for (const seed of seeds) {
      // Fresh data dir for every run: a simulation must not resume the
      // population another run left behind
      git(worktree, ['clean', '-fdxq', '--', 'data']);
      const r = await this.runIsolated(worktree, [
        'src/index.js', `--simulate=${cfg.selfEditGenerations}`, `--seed=${seed}`, '--eval-test',
      ], cfg.selfEditTimeoutMs);
      const path = r.stdout.match(/Summary saved to (.+)/)?.[1]?.trim();
      if (r.code !== 0 || !path || !existsSync(path)) {
        results.push({ seed, extinct: true, score: 0, testScore: null, failed: true, error: (r.stderr || '').slice(-500) });
        continue;
      }
      results.push({ seed, ...scoreSummary(JSON.parse(readFileSync(path, 'utf-8'))) });
    }
    return results;
  }

  _prepareWorktree(sha) {
    const worktree = join(this.workDir, 'worktree');
    try { git(this.root, ['worktree', 'remove', '--force', worktree]); } catch { /* not registered */ }
    rmSync(worktree, { recursive: true, force: true });
    git(this.root, ['worktree', 'prune']);
    mkdirSync(this.workDir, { recursive: true });
    git(this.root, ['worktree', 'add', '--detach', worktree, sha]);
    if (!existsSync(join(worktree, 'node_modules'))) symlinkSync(realpathSync(resolve(this.root, 'node_modules')), join(worktree, 'node_modules'));
    return worktree;
  }

  _removeWorktree(worktree) {
    try { git(this.root, ['worktree', 'remove', '--force', worktree]); } catch { /* already gone */ }
    rmSync(worktree, { recursive: true, force: true });
  }

  // Judge a new version of `file` against the unmodified code at `sha`
  async judge(sha, file, newSource) {
    const cfg = getConfig().selfprog;
    const seeds = Array.from({ length: cfg.selfEditSeeds }, (_, i) => `selfedit-${i}`);
    const worktree = this._prepareWorktree(sha);
    let verdict = null;
    try {
      verdict = await this._judgeIn(worktree, sha, file, newSource, cfg, seeds);
      return verdict;
    } finally {
      // Kept only when accepted: run() commits from it, then removes it
      if (!verdict?.accepted) this._removeWorktree(worktree);
    }
  }

  async _judgeIn(worktree, sha, file, newSource, cfg, seeds) {
    const state = loadState(this.root);
    const baselineKey = `${sha}:${cfg.selfEditGenerations}:${seeds.join(',')}`;
    let baseline = state.baselines?.[baselineKey];
    if (!baseline) {
      baseline = await this._simulate(worktree, seeds, cfg);
      state.baselines = { [baselineKey]: baseline }; // only the current HEAD matters
      saveState(state, this.root);
    }
    if (baseline.some(b => b.failed)) {
      return { accepted: false, reason: 'baseline_failed', baseline };
    }

    writeFileSync(join(worktree, file), newSource);

    const tests = await this.runIsolated(worktree, ['--test', '--experimental-test-isolation=none'], cfg.selfEditTimeoutMs);
    const testSummary = (tests.stdout.match(/# (pass|fail) \d+/g) || []).join(', ');
    if (tests.code !== 0) {
      return { accepted: false, reason: tests.timedOut ? 'tests_timeout' : 'tests_failed', tests: testSummary, output: tests.stdout.slice(-1500) };
    }

    const candidate = await this._simulate(worktree, seeds, cfg);
    const mean = (xs) => xs.reduce((s, x) => s + x.score, 0) / xs.length;
    const metrics = {
      tests: testSummary,
      baselineScore: mean(baseline),
      candidateScore: mean(candidate),
      baseline,
      candidate,
    };

    if (candidate.some(c => c.extinct || c.failed)) return { accepted: false, reason: 'extinction_or_crash', ...metrics };
    const testLoss = candidate.some((c, i) => c.testScore != null && baseline[i].testScore != null && c.testScore < baseline[i].testScore);
    if (testLoss) return { accepted: false, reason: 'held_out_regression', ...metrics };
    if (metrics.candidateScore < metrics.baselineScore + cfg.selfEditMinGain) {
      return { accepted: false, reason: 'no_improvement', ...metrics };
    }
    return { accepted: true, worktree, ...metrics };
  }

  async _propose(file, target) {
    const prompt = `You are improving one ${target.kind} of your own source code (iaADN, a self-evolving AI). File: ${file}

\`\`\`js
${target.text}
\`\`\`

Rewrite this ${target.kind} so it works better — more correct, more robust, or better at helping evolution find strong genomes.
Rules:
- Keep the same name and parameters, and return the same kind of value.
- Do not add imports. Do not use process, globalThis, require, eval, Function, fetch or timers.
- Reply with ONLY the complete rewritten ${target.kind}, no explanations.`;

    const result = await this.inferenceEngine.complete([{ role: 'user', content: prompt }], { temperature: 0.4, maxTokens: 1024 });
    return extractSnippet(result.content);
  }

  _log(event, data) {
    this.auditLog?.log(`selfedit_${event}`, data);
    const state = loadState(this.root);
    state.history.push({ type: event, at: Date.now(), ...data });
    state.history = state.history.slice(-200);
    saveState(state, this.root);
  }

  // One autonomous cycle. `proposal` lets tests (or an operator) supply the
  // replacement instead of asking the model.
  async run({ proposal = null } = {}) {
    const cfg = getConfig().selfprog;
    if (!cfg.selfEditEnabled) return { skipped: true, reason: 'disabled' };
    if (this.killSwitch?.isActive()) return { skipped: true, reason: 'kill_switch' };
    if (this.running) return { skipped: true, reason: 'already_running' };

    if (this.isolation === null) this.isolation = await SelfEdit.detectIsolation();
    if (!this.isolation) {
      console.log('[SelfEdit] No network isolation available (unshare -rn failed) — source self-edit stays off');
      return { skipped: true, reason: 'no_network_isolation' };
    }

    const state = loadState(this.root);
    if (state.pending && !state.pending.verified) return { skipped: true, reason: 'previous_edit_unverified' };
    const appliedToday = state.history.filter(h => h.type === 'applied' && Date.now() - h.at < DAY_MS).length;
    if (appliedToday >= cfg.selfEditMaxPerDay) return { skipped: true, reason: 'daily_limit' };

    let sha;
    try {
      if (git(this.root, ['status', '--porcelain', '--untracked-files=no'])) return { skipped: true, reason: 'live_checkout_dirty' };
      sha = git(this.root, ['rev-parse', 'HEAD']);
    } catch {
      return { skipped: true, reason: 'not_a_git_repo' };
    }

    this.running = true;
    try {
      // 1. Pick a function
      const file = proposal?.file || rng.pick(IMMUTABLE_RULES.selfEditAllowlist);
      const source = readFileSync(resolve(this.root, file), 'utf-8');
      const functions = listFunctions(source);
      const target = proposal?.name ? functions.find(f => f.name === proposal.name) : rng.pick(functions);
      if (!target) return { success: false, reason: 'no_target' };

      // 2. Propose a rewrite
      const snippet = proposal?.snippet ?? await this._propose(file, target);

      // 3. Static gate
      const check = checkPatch(file, source, target, snippet);
      if (!check.valid) {
        this._log('rejected', { file, fn: target.name, reason: 'static_check', errors: check.errors });
        return { success: false, reason: 'static_check', errors: check.errors };
      }

      // 4. Judge
      const verdict = await this.judge(sha, file, check.newSource);
      if (!verdict.accepted) {
        const { baseline, candidate, output, ...summary } = verdict;
        this._log('rejected', { file, fn: target.name, ...summary });
        console.log(`[SelfEdit] ${file}#${target.name} rejected: ${verdict.reason}`);
        return { success: false, ...summary, baseline, candidate, output };
      }

      // 5. Apply: commit in the worktree, fast-forward the live checkout
      const commit = this._commit(verdict.worktree, file, target, verdict);
      this._removeWorktree(verdict.worktree);
      if (git(this.root, ['rev-parse', 'HEAD']) !== sha || git(this.root, ['status', '--porcelain', '--untracked-files=no'])) {
        this._log('rejected', { file, fn: target.name, reason: 'live_checkout_changed' });
        return { success: false, reason: 'live_checkout_changed' };
      }
      git(this.root, ['merge', '--ff-only', commit]);
      git(this.root, ['branch', '-f', 'evolved', commit]);

      const after = loadState(this.root);
      after.pending = { commit, previous: sha, appliedAt: Date.now(), boots: 0, verified: false };
      saveState(after, this.root);
      this._log('applied', {
        file, fn: target.name, commit, previous: sha,
        baselineScore: verdict.baselineScore, candidateScore: verdict.candidateScore, tests: verdict.tests,
      });
      console.log(`[SelfEdit] Applied ${file}#${target.name} as ${commit.slice(0, 10)} (${verdict.baselineScore.toFixed(4)} -> ${verdict.candidateScore.toFixed(4)})`);

      if (this.onApplied) await this.onApplied({ commit });
      return { success: true, file, fn: target.name, commit, baselineScore: verdict.baselineScore, candidateScore: verdict.candidateScore };
    } finally {
      this.running = false;
    }
  }

  _commit(worktree, file, target, verdict) {
    git(worktree, ['add', file]);
    const message = [
      `self-edit: ${file} ${target.name}()`,
      '',
      `Judge: ${verdict.tests}; seeded simulations ${verdict.baselineScore.toFixed(4)} -> ${verdict.candidateScore.toFixed(4)}.`,
      'Written by the local model, applied without human review by src/selfprog/self-edit.js.',
    ].join('\n');
    git(worktree, [...SELF_EDIT_AUTHOR, 'commit', '-m', message]);
    return git(worktree, ['rev-parse', 'HEAD']);
  }

  // Once the daemon has stayed up for the rollback window, the pending edit
  // is marked verified so the boot guard stops counting restarts.
  scheduleVerification() {
    const state = loadState(this.root);
    const pending = state.pending;
    if (!pending || pending.verified) return null;
    const windowMs = getConfig().selfprog.selfEditRollbackWindowMs;
    const timer = setTimeout(() => markVerified(pending.commit, this.root), windowMs);
    timer.unref();
    return timer;
  }

  getHistory() {
    const state = loadState(this.root);
    return { pending: state.pending, history: state.history.slice(-50) };
  }
}
