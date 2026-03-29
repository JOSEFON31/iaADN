// iaADN - Cron: schedules autonomous cycles
// Each cycle runs on its own interval, independently

export class CronScheduler {
  constructor() {
    this.tasks = new Map(); // name -> { interval, timer, running, lastRun, handler }
  }

  // Register a recurring task
  // Options: { delay: ms } — wait before first execution
  register(name, intervalMs, handler, options = {}) {
    this.tasks.set(name, {
      interval: intervalMs,
      timer: null,
      running: false,
      lastRun: null,
      lastDuration: null,
      runCount: 0,
      errors: 0,
      delay: options.delay || 0,
      gate: options.gate || null,
      handler,
    });
  }

  // Start a specific task
  start(name) {
    const task = this.tasks.get(name);
    if (!task) throw new Error(`Unknown task: ${name}`);

    const run = async () => {
      if (task.running) return; // skip if previous run still in progress
      task.running = true;
      const startTime = Date.now();

      try {
        await task.handler();
        task.runCount++;
      } catch (err) {
        task.errors++;
        console.error(`[Cron] Error in ${name}: ${err.message}`);
      } finally {
        task.running = false;
        task.lastRun = Date.now();
        task.lastDuration = Date.now() - startTime;
      }
    };

    // First execution: gate > delay > immediate
    if (task.gate) {
      task.gate.then(() => run()).catch(() => run());
    } else if (task.delay > 0) {
      setTimeout(() => { run(); }, task.delay);
    } else {
      run();
    }
    task.timer = setInterval(run, task.interval);
  }

  // Start all registered tasks
  startAll() {
    for (const name of this.tasks.keys()) {
      this.start(name);
    }
  }

  // Stop a specific task
  stop(name) {
    const task = this.tasks.get(name);
    if (task?.timer) {
      clearInterval(task.timer);
      task.timer = null;
    }
  }

  // Stop all tasks
  stopAll() {
    for (const name of this.tasks.keys()) {
      this.stop(name);
    }
  }

  // Get status of all tasks
  getStatus() {
    const status = {};
    for (const [name, task] of this.tasks) {
      status[name] = {
        interval: task.interval,
        running: task.running,
        lastRun: task.lastRun,
        lastDuration: task.lastDuration,
        runCount: task.runCount,
        errors: task.errors,
        active: task.timer !== null,
      };
    }
    return status;
  }
}
