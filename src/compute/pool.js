// iaADN - Compute Pool: shared processing power across nodes
// Nodes contribute CPU/GPU resources and get paid in IOTAI tokens

import { EventEmitter } from 'events';

export class ComputePool extends EventEmitter {
  constructor({ node, iotaiBridge, resourceLimits }) {
    super();
    this.node = node;
    this.iotaiBridge = iotaiBridge;
    this.resourceLimits = resourceLimits;

    this.activeTasks = new Map(); // taskId -> { task, worker, startTime }
    this.taskQueue = [];          // pending tasks
    this.completedTasks = [];     // recent completed tasks
    this.maxConcurrent = 3;
  }

  // Submit a task to the compute pool
  async submitTask(task) {
    const taskEntry = {
      id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      ...task,
      submittedAt: Date.now(),
      status: 'pending',
    };

    // Try local execution first
    if (this.activeTasks.size < this.maxConcurrent) {
      return this._executeLocally(taskEntry);
    }

    // Queue for later or distribute to peers
    this.taskQueue.push(taskEntry);
    this.emit('task_queued', taskEntry);

    // Try to offload to a peer
    if (this.node.peers.size > 0) {
      await this._distributeTask(taskEntry);
    }

    return taskEntry;
  }

  // Execute a task locally
  async _executeLocally(taskEntry) {
    taskEntry.status = 'running';
    taskEntry.startTime = Date.now();
    this.activeTasks.set(taskEntry.id, taskEntry);

    try {
      // Execute based on task type
      let result;
      switch (taskEntry.type) {
        case 'inference':
          result = taskEntry.payload; // placeholder — actual inference handled by caller
          break;
        case 'evaluation':
          result = taskEntry.payload;
          break;
        default:
          result = { message: 'Unknown task type' };
      }

      taskEntry.status = 'completed';
      taskEntry.result = result;
      taskEntry.completedAt = Date.now();
      taskEntry.duration = taskEntry.completedAt - taskEntry.startTime;

      this.activeTasks.delete(taskEntry.id);
      this.completedTasks.push(taskEntry);
      if (this.completedTasks.length > 100) this.completedTasks.shift();

      this.emit('task_completed', taskEntry);

      // Process queue
      this._processQueue();

      return taskEntry;
    } catch (err) {
      taskEntry.status = 'failed';
      taskEntry.error = err.message;
      this.activeTasks.delete(taskEntry.id);
      this.emit('task_failed', taskEntry);
      this._processQueue();
      return taskEntry;
    }
  }

  // Distribute a task to a peer node
  async _distributeTask(taskEntry) {
    const peers = this.node.getPeers();
    if (peers.length === 0) return;

    // Pick the least loaded peer
    const peer = peers.sort((a, b) =>
      (a.capabilities?.activeTasks || 0) - (b.capabilities?.activeTasks || 0)
    )[0];

    await this.node.sendToPeer(peer.peerId, '/iaADN/compute/1.0.0', {
      type: 'compute_request',
      data: taskEntry,
      senderId: this.node.nodeId,
    });
  }

  _processQueue() {
    while (this.taskQueue.length > 0 && this.activeTasks.size < this.maxConcurrent) {
      const task = this.taskQueue.shift();
      this._executeLocally(task);
    }
  }

  // Get pool status
  getStatus() {
    return {
      activeTasks: this.activeTasks.size,
      queuedTasks: this.taskQueue.length,
      completedTasks: this.completedTasks.length,
      resources: this.resourceLimits.getSystemResources(),
    };
  }
}
