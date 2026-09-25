// iaADN - Source self-edit state and rollback. Deliberately imports nothing
// from the editable code (src/evolution/, src/genome/), so the boot guard
// still works when an applied edit breaks the rest of the program at import.

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SELF_EDIT_AUTHOR = ['-c', 'user.name=iaADN self-edit', '-c', 'user.email=self-edit@iaadn.local'];

export function statePath(root = PROJECT_ROOT) {
  return resolve(root, 'data', 'selfedit', 'state.json');
}

export function loadState(root = PROJECT_ROOT) {
  const path = statePath(root);
  if (!existsSync(path)) return { history: [], pending: null, baselines: {} };
  try {
    const state = JSON.parse(readFileSync(path, 'utf-8'));
    return { history: [], pending: null, baselines: {}, ...state };
  } catch {
    return { history: [], pending: null, baselines: {} };
  }
}

export function saveState(state, root = PROJECT_ROOT) {
  const path = statePath(root);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

export function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// Runs before every daemon start (systemd ExecStartPre / `npm run daemon`).
// After an applied edit, each start inside the rollback window counts; the
// first is the intended restart. If the program keeps restarting — it
// crashes, even at import time — the edit is reverted before the next start.
// The running daemon marks the edit verified once it survives the window.
export function bootGuard({ root = PROJECT_ROOT, maxCrashes = 3, now = Date.now() } = {}) {
  const state = loadState(root);
  const pending = state.pending;
  if (!pending) return { action: 'none' };

  let head;
  try {
    head = git(root, ['rev-parse', 'HEAD']);
  } catch {
    return { action: 'none', reason: 'not_a_git_repo' };
  }

  if (pending.verified || head !== pending.commit) {
    state.pending = null;
    saveState(state, root);
    return { action: pending.verified ? 'verified' : 'head_moved' };
  }

  pending.boots = (pending.boots || 0) + 1;
  if (pending.boots <= maxCrashes) {
    saveState(state, root);
    return { action: 'counted', boots: pending.boots };
  }

  git(root, [...SELF_EDIT_AUTHOR, 'revert', '--no-edit', pending.commit]);
  const reverted = git(root, ['rev-parse', 'HEAD']);
  state.history.push({
    type: 'rollback',
    at: now,
    commit: pending.commit,
    revertCommit: reverted,
    reason: `restarted ${pending.boots - 1} time(s) within the rollback window`,
  });
  state.pending = null;
  saveState(state, root);
  return { action: 'reverted', commit: pending.commit, revertCommit: reverted };
}

// Called by the running daemon once an applied edit has survived the window
export function markVerified(commit, root = PROJECT_ROOT) {
  const state = loadState(root);
  if (state.pending?.commit === commit) {
    state.pending.verified = true;
    state.history.push({ type: 'verified', at: Date.now(), commit });
    saveState(state, root);
  }
}
