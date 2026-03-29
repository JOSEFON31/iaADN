// iaADN - Resource Limits: monitor and enforce resource consumption
// Prevents any instance from consuming too many resources

import { cpus, totalmem, freemem } from 'os';

export class ResourceLimits {
  constructor(limits = {}) {
    this.limits = {
      maxCpuPercent: limits.maxCpuPercent || 80,
      maxMemoryPercent: limits.maxMemoryPercent || 90,
      maxInstancesPerNode: limits.maxInstancesPerNode || 10,
      maxDiskUsageMB: limits.maxDiskUsageMB || 5000,
      ...limits,
    };
    this.instanceCount = 0;
    this.bandwidthUsed = 0; // bytes per hour
    this.bandwidthResetTime = Date.now();
  }

  // Check if system has enough resources for another instance
  canSpawnInstance() {
    if (this.instanceCount >= this.limits.maxInstancesPerNode) {
      return { allowed: false, reason: `Max instances reached (${this.limits.maxInstancesPerNode})` };
    }

    const memPercent = ((totalmem() - freemem()) / totalmem()) * 100;
    if (memPercent > this.limits.maxMemoryPercent) {
      return { allowed: false, reason: `Memory usage too high (${memPercent.toFixed(1)}%)` };
    }

    return { allowed: true };
  }

  // Get current system resource usage
  getSystemResources() {
    const totalMem = totalmem();
    const freeMem = freemem();
    const usedMem = totalMem - freeMem;

    return {
      cpuCores: cpus().length,
      cpuModel: cpus()[0]?.model || 'unknown',
      totalMemoryMB: Math.round(totalMem / (1024 * 1024)),
      freeMemoryMB: Math.round(freeMem / (1024 * 1024)),
      usedMemoryMB: Math.round(usedMem / (1024 * 1024)),
      memoryPercent: ((usedMem / totalMem) * 100).toFixed(1),
      instanceCount: this.instanceCount,
      bandwidthUsedMB: Math.round(this.bandwidthUsed / (1024 * 1024)),
    };
  }

  // Track bandwidth usage
  trackBandwidth(bytes) {
    // Reset hourly
    if (Date.now() - this.bandwidthResetTime > 3600000) {
      this.bandwidthUsed = 0;
      this.bandwidthResetTime = Date.now();
    }
    this.bandwidthUsed += bytes;
  }

  // Check if bandwidth limit is exceeded
  isBandwidthExceeded(maxPerHour) {
    if (Date.now() - this.bandwidthResetTime > 3600000) {
      this.bandwidthUsed = 0;
      this.bandwidthResetTime = Date.now();
    }
    return this.bandwidthUsed > maxPerHour;
  }

  // Register a new instance
  registerInstance() {
    this.instanceCount++;
  }

  // Unregister an instance
  unregisterInstance() {
    this.instanceCount = Math.max(0, this.instanceCount - 1);
  }
}
