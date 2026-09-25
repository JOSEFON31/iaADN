// iaADN - Source self-edit: static gate, judge, apply and rollback.
// The full-cycle tests build a throwaway git repo from the current working
// tree and run the real judge in it (network namespace + permission model).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { isSelfEditable } from '../src/safety/rules.js';
import { listFunctions, checkPatch, SelfEdit } from '../src/selfprog/self-edit.js';
import { bootGuard, loadState, saveState } from '../src/selfprog/self-edit-state.js';
import { loadConfig } from '../src/config.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Inside the judge's own isolated run there are no child processes (and no
// git): those tests skip there. Everywhere else they run.
const canSpawn = !process.permission || process.permission.has('child');
const isolation = canSpawn ? await SelfEdit.detectIsolation() : false;
const noSpawn = canSpawn ? false : 'no child processes under the permission model';
const noIsolation = !canSpawn ? noSpawn : isolation ? false : 'unshare -rn not available on this machine';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const AS = ['-c', 'user.name=test', '-c', 'user.email=test@test'];

// A git repo holding the current working tree (tracked + new files)
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'iaadn-selfedit-repo-'));
  const files = git(ROOT, 'ls-files', '-co', '--exclude-standard').split('\n').filter(f => f && !f.startsWith('data/'));
  for (const f of files) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), readFileSync(join(ROOT, f)));
  }
  for (const d of ['models', 'adapters', 'genomes', 'training', 'snapshots', 'audit']) {
    mkdirSync(join(dir, 'data', d), { recursive: true });
    writeFileSync(join(dir, 'data', d, '.gitkeep'), '');
  }
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, ...AS, 'commit', '-qm', 'base');
  return dir;
}

const SELECTION = 'src/evolution/selection.js';

describe('Self-edit static gate', () => {
  const source = readFileSync(join(ROOT, SELECTION), 'utf-8');
  const target = listFunctions(source).find(f => f.name === 'tournamentSelection');

  it('only allowlisted, unprotected files are editable', () => {
    assert.equal(isSelfEditable('src/evolution/selection.js'), true);
    assert.equal(isSelfEditable('./src/genome/gene.js'), true);
    for (const p of ['src/safety/rules.js', 'src/selfprog/self-edit.js', 'src/evaluation/tasks.js', 'tests/selfedit.test.js',
      'src/index.js', 'package.json', 'src/evolution/../safety/rules.js', 'src/evolution/fitness.js']) {
      assert.equal(isSelfEditable(p), false, p);
    }
  });

  it('finds class methods to target', () => {
    assert.ok(target, 'tournamentSelection should be a candidate');
    assert.equal(target.kind, 'method');
  });

  it('accepts a same-name rewrite and splices it into the file', () => {
    const snippet = target.text.replace('{', '{\n    // rewritten\n');
    const check = checkPatch(SELECTION, source, target, snippet);
    assert.equal(check.valid, true, check.errors.join('; '));
    assert.ok(check.newSource.includes('// rewritten'));
  });

  it('rejects patches that gain capabilities or change shape', () => {
    const body = (extra) => target.text.replace('{', `{\n    ${extra}\n`);
    const cases = {
      process: body('process.exit(1);'),
      require: body('const fs = require("fs");'),
      dynamicImport: body('import("fs");'),
      globalThis: body('globalThis.x = 1;'),
      constructorEscape: body('[].constructor.constructor("return 1")();'),
      evalCall: body('eval("1");'),
      fetchCall: body('fetch("https://example.com");'),
      renamed: target.text.replace('tournamentSelection', 'somethingElse'),
      twoMethods: `${target.text}\n  extra() { return 1; }`,
      garbage: 'this is not code {',
      identical: target.text,
    };
    for (const [name, snippet] of Object.entries(cases)) {
      assert.equal(checkPatch(SELECTION, source, target, snippet).valid, false, name);
    }
  });

  it('rejects any file outside the allowlist, even with a harmless patch', () => {
    const rules = readFileSync(join(ROOT, 'src/safety/rules.js'), 'utf-8');
    const fn = listFunctions(rules)[0];
    const check = checkPatch('src/safety/rules.js', rules, fn, fn.text.replace('{', '{\n  // x\n'));
    assert.equal(check.valid, false);
  });
});

describe('Self-edit boot guard (rollback)', { skip: noSpawn }, () => {
  let repo;
  before(() => {
    repo = mkdtempSync(join(tmpdir(), 'iaadn-bootguard-'));
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'a.txt'), 'original\n');
    git(repo, 'add', '-A');
    git(repo, ...AS, 'commit', '-qm', 'base');
  });
  after(() => rmSync(repo, { recursive: true, force: true }));

  const applyEdit = () => {
    writeFileSync(join(repo, 'a.txt'), 'edited\n');
    git(repo, ...AS, 'commit', '-qam', 'self-edit');
    const commit = git(repo, 'rev-parse', 'HEAD');
    saveState({ history: [], baselines: {}, pending: { commit, appliedAt: Date.now(), boots: 0, verified: false } }, repo);
    return commit;
  };

  it('counts restarts, then reverts an edit that keeps crashing', () => {
    const commit = applyEdit();
    assert.equal(bootGuard({ root: repo, maxCrashes: 3 }).action, 'counted'); // the intended restart
    assert.equal(bootGuard({ root: repo, maxCrashes: 3 }).action, 'counted');
    assert.equal(bootGuard({ root: repo, maxCrashes: 3 }).action, 'counted');
    const result = bootGuard({ root: repo, maxCrashes: 3 });
    assert.equal(result.action, 'reverted');
    assert.equal(readFileSync(join(repo, 'a.txt'), 'utf-8'), 'original\n');
    const state = loadState(repo);
    assert.equal(state.pending, null);
    assert.equal(state.history.at(-1).commit, commit);
    assert.equal(bootGuard({ root: repo }).action, 'none');
  });

  it('stops counting once the running daemon marks the edit verified', () => {
    applyEdit();
    const state = loadState(repo);
    state.pending.verified = true;
    saveState(state, repo);
    assert.equal(bootGuard({ root: repo, maxCrashes: 0 }).action, 'verified');
    assert.equal(readFileSync(join(repo, 'a.txt'), 'utf-8'), 'edited\n');
  });
});

describe('Self-edit isolation and full cycle', { skip: noIsolation }, () => {
  let repo;
  before(() => {
    loadConfig({ selfprog: { selfEditEnabled: true, selfEditSeeds: 2, selfEditGenerations: 4, selfEditMinGain: 0.005, selfEditMaxPerDay: 5 } });
    repo = makeRepo();
  });
  after(() => {
    rmSync(repo, { recursive: true, force: true });
    loadConfig();
  });

  it('the judge process has no network, no writes outside its worktree and no child processes', async () => {
    const se = new SelfEdit({ root: repo });
    const wt = mkdtempSync(join(tmpdir(), 'iaadn-iso-'));
    try {
      const probe = [
        "fetch('https://example.com').then(() => console.log('NET_OPEN')).catch(() => console.log('NET_BLOCKED'))",
        "try { require('fs').writeFileSync('/tmp/iaadn-escape', 'x'); console.log('WRITE_OPEN') } catch { console.log('WRITE_BLOCKED') }",
        "try { require('child_process').execSync('true'); console.log('SPAWN_OPEN') } catch { console.log('SPAWN_BLOCKED') }",
      ].join(';');
      const r = await se.runIsolated(wt, ['-e', probe], 20000);
      assert.match(r.stdout, /NET_BLOCKED/);
      assert.match(r.stdout, /WRITE_BLOCKED/);
      assert.match(r.stdout, /SPAWN_BLOCKED/);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it('rejects a patch that breaks the test suite, leaving the live code untouched', async () => {
    const se = new SelfEdit({ root: repo });
    const before = readFileSync(join(repo, SELECTION), 'utf-8');
    const target = listFunctions(before).find(f => f.name === 'selectParents');
    const signature = target.text.slice(0, target.text.indexOf('{') + 1);
    const result = await se.run({ proposal: { file: SELECTION, name: 'selectParents', snippet: `${signature}\n    return [];\n  }` } });
    assert.equal(result.success, false);
    assert.equal(result.reason, 'tests_failed');
    assert.equal(readFileSync(join(repo, SELECTION), 'utf-8'), before);
  });

  it('rejects a harmless patch that does not improve fitness', async () => {
    const se = new SelfEdit({ root: repo });
    const source = readFileSync(join(repo, SELECTION), 'utf-8');
    const target = listFunctions(source).find(f => f.name === 'tournamentSelection');
    const result = await se.run({ proposal: { file: SELECTION, name: 'tournamentSelection', snippet: target.text.replace('{', '{\n    // same behaviour\n') } });
    assert.equal(result.reason, 'no_improvement');
    assert.equal(result.baselineScore, result.candidateScore, 'seeded simulations are deterministic');
  });

  it('applies an accepted edit as a local commit, then the boot guard can roll it back', async () => {
    loadConfig({ selfprog: { selfEditEnabled: true, selfEditSeeds: 2, selfEditGenerations: 4, selfEditMinGain: -1, selfEditMaxPerDay: 5 } });
    const base = git(repo, 'rev-parse', 'HEAD');
    let applied = null;
    const se = new SelfEdit({ root: repo, onApplied: (info) => { applied = info; } });
    const source = readFileSync(join(repo, SELECTION), 'utf-8');
    const target = listFunctions(source).find(f => f.name === 'tournamentSelection');

    const result = await se.run({ proposal: { file: SELECTION, name: 'tournamentSelection', snippet: target.text.replace('{', '{\n    // accepted edit\n') } });

    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(applied.commit, result.commit);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), result.commit);
    assert.equal(git(repo, 'rev-parse', 'evolved'), result.commit);
    assert.equal(git(repo, 'rev-parse', 'HEAD~1'), base);
    assert.match(git(repo, 'log', '-1', '--format=%an'), /iaADN self-edit/);
    assert.ok(readFileSync(join(repo, SELECTION), 'utf-8').includes('// accepted edit'));
    assert.equal(loadState(repo).pending.commit, result.commit);

    // Another cycle waits until this edit is verified
    assert.equal((await se.run()).reason, 'previous_edit_unverified');

    for (let i = 0; i < 3; i++) assert.equal(bootGuard({ root: repo, maxCrashes: 3 }).action, 'counted');
    assert.equal(bootGuard({ root: repo, maxCrashes: 3 }).action, 'reverted');
    assert.ok(!readFileSync(join(repo, SELECTION), 'utf-8').includes('// accepted edit'));
  });
});
