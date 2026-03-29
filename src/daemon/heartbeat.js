// iaADN - Heartbeat: monitors node health and detects failures
// Checks every minute that all systems are operational

export class Heartbeat {
  constructor({ guardian, population, killSwitch }) {
    this.guardian = guardian;
    this.population = population;
    this.killSwitch = killSwitch;
    this.history = []; // last N heartbeat results
    this.maxHistory = 60; // keep last 60 heartbeats (1 hour at 1/min)
  }

  // Run one heartbeat check
  async run() {
    const status = {
      timestamp: Date.now(),
      healthy: true,
      checks: {},
    };

    // 1. Check resources
    const resources = this.guardian.getResourceStatus();
    status.checks.resources = {
      ok: true,
      cpuCores: resources.cpuCores,
      freeMemoryMB: resources.freeMemoryMB,
      memoryPercent: resources.memoryPercent,
    };

    // Check for critical memory
    if (this.killSwitch.checkAutoTrigger(resources)) {
      status.healthy = false;
      status.checks.resources.ok = false;
    }

    // 2. Check population
    const living = this.population.getLiving();
    status.checks.population = {
      ok: living.length > 0,
      count: living.length,
    };
    if (living.length === 0) {
      status.healthy = false;
    }

    // 3. Check kill switch
    status.checks.killSwitch = {
      ok: !this.killSwitch.isActive(),
      active: this.killSwitch.isActive(),
    };
    if (this.killSwitch.isActive()) {
      status.healthy = false;
    }

    // Store in history
    this.history.push(status);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    return status;
  }

  // Get health summary
  getHealth() {
    if (this.history.length === 0) return { healthy: true, uptimePercent: 100 };

    const healthyCount = this.history.filter(h => h.healthy).length;
    const latest = this.history[this.history.length - 1];

    return {
      healthy: latest?.healthy ?? true,
      uptimePercent: Math.round((healthyCount / this.history.length) * 100),
      totalChecks: this.history.length,
      latestCheck: latest,
    };
  }
}
