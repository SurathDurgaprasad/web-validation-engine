const pLimitModule = require('p-limit');
const pLimit = pLimitModule.default || pLimitModule;

class QueueManager {
  constructor(concurrency) {
    this.limit = pLimit(concurrency);
    this.tasks = [];
    this.activeTasks = 0;
    this.completedTasks = 0;
  }

  add(task) {
    const wrapped = this.limit(async () => {
      this.activeTasks++;
      try {
        await task();
      } finally {
        this.activeTasks--;
        this.completedTasks++;
      }
    });

    this.tasks.push(wrapped);
  }

  async waitForIdle() {
    // Wait until all tasks (including tasks added while running) are finished.
    // Loop until completedTasks matches the number of scheduled tasks and no active tasks remain.
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    while (true) {
      const totalScheduled = this.tasks.length;
      if (this.completedTasks >= totalScheduled && this.activeTasks === 0) {
        return;
      }
      // Wait for currently scheduled tasks to settle, then re-check.
      try {
        await Promise.allSettled(this.tasks.slice(this.completedTasks));
      } catch (e) {
        // ignore and re-check loop
      }
      await sleep(100);
    }
  }

  getStats() {
    return {
      queued: this.tasks.length,
      active: this.activeTasks,
      completed: this.completedTasks
    };
  }
}

module.exports = QueueManager;