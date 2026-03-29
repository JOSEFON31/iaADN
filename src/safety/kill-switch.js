// iaADN - Kill Switch: emergency shutdown mechanism
// Can halt all instances, notify peers, and preserve last-known-good state

import { EventEmitter } from 'events';

export class KillSwitch extends EventEmitter {
  constructor(auditLog) {
    super();
    this.auditLog = auditLog;
    this.activated = false;
    this.activationReason = null;
    this.activationTime = null;
  }

  // Activate kill switch — stops everything
  activate(reason) {
    if (this.activated) return;

    this.activated = true;
    this.activationReason = reason;
    this.activationTime = Date.now();

    if (this.auditLog) {
      this.auditLog.log('kill_switch_activated', { reason });
    }

    this.emit('activated', { reason, timestamp: this.activationTime });
    console.error(`[KILL SWITCH] Activated: ${reason}`);
  }

  // Reset kill switch (requires explicit action)
  reset() {
    if (!this.activated) return;

    if (this.auditLog) {
      this.auditLog.log('kill_switch_reset', {
        wasActivatedAt: this.activationTime,
        reason: this.activationReason,
      });
    }

    this.activated = false;
    this.activationReason = null;
    this.activationTime = null;

    this.emit('reset');
  }

  // Check if kill switch is active
  isActive() {
    return this.activated;
  }

  // Get status
  getStatus() {
    return {
      activated: this.activated,
      reason: this.activationReason,
      activatedAt: this.activationTime,
    };
  }

  // Auto-trigger conditions
  checkAutoTrigger(resourceStatus) {
    const memPercent = parseFloat(resourceStatus.memoryPercent);

    // Track consecutive high-memory readings to avoid false triggers during inference spikes
    if (memPercent > 97) {
      this._highMemCount = (this._highMemCount || 0) + 1;
    } else {
      this._highMemCount = 0;
    }

    // Only trigger if memory is critically high for 3 consecutive checks (3 minutes)
    if (this._highMemCount >= 3) {
      this.activate('Critical memory usage > 97% for 3+ minutes');
      return true;
    }

    return false;
  }
}
