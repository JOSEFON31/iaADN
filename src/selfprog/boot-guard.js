// iaADN - Boot guard: run before starting the daemon (see self-edit-state.js).
// Reverts an applied source self-edit that keeps the program from staying up.

import { bootGuard } from './self-edit-state.js';
import { getConfig } from '../config.js';

try {
  const result = bootGuard({ maxCrashes: getConfig().selfprog.selfEditMaxCrashes });
  if (result.action === 'reverted') {
    console.log(`[BootGuard] Reverted self-edit ${result.commit} (now at ${result.revertCommit})`);
  } else if (result.action === 'counted') {
    console.log(`[BootGuard] Start #${result.boots} after a self-edit, still inside its rollback window`);
  }
} catch (err) {
  // Never block the daemon from starting because of the guard itself
  console.error(`[BootGuard] ${err.message}`);
}
