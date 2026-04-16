/* ────────────────────────────────────────────────────────────
   TaskQueue — Priority queue with concurrency slots,
   per-task timeouts, and graceful cancellation.
   ──────────────────────────────────────────────────────────── */

export type TaskPriority = 'critical' | 'normal' | 'low';

export interface QueuedTask<T = unknown> {
  id: string;
  projectName: string;
  priority: TaskPriority;
  timeoutMs: number;
  execute: (signal: AbortSignal) => Promise<T>;
}

interface RunningTask<T = unknown> {
  task: QueuedTask<T>;
  abortController: AbortController;
  timeoutHandle: ReturnType<typeof setTimeout>;
  startedAt: number;
}

interface TaskResult<T = unknown> {
  taskId: string;
  success: boolean;
  result?: T;
  error?: string;
  durationMs: number;
  timedOut: boolean;
}

type TaskResultCallback<T = unknown> = (result: TaskResult<T>) => void;

const PRIORITY_ORDER: Record<TaskPriority, number> = {
  critical: 0,
  normal: 1,
  low: 2,
};

export class TaskQueue<T = unknown> {
  private pending: Array<{ task: QueuedTask<T>; callback: TaskResultCallback<T> }> = [];
  private running = new Map<string, RunningTask<T>>();
  private readonly maxConcurrency: number;
  private draining = false;

  constructor(maxConcurrency = 3) {
    this.maxConcurrency = Math.max(1, maxConcurrency);
  }

  /**
   * Enqueue a task. Returns a promise that resolves when the task completes.
   */
  enqueue(task: QueuedTask<T>): Promise<TaskResult<T>> {
    return new Promise<TaskResult<T>>((resolve) => {
      this.pending.push({ task, callback: resolve });
      // Keep pending queue sorted by priority
      this.pending.sort((a, b) => PRIORITY_ORDER[a.task.priority] - PRIORITY_ORDER[b.task.priority]);
      this.tryRunNext();
    });
  }

  /**
   * Cancel a specific task by ID. If running, aborts it. If pending, removes it.
   */
  cancel(taskId: string): boolean {
    // Check running tasks
    const running = this.running.get(taskId);
    if (running) {
      clearTimeout(running.timeoutHandle);
      running.abortController.abort();
      return true;
    }

    // Check pending queue
    const pendingIndex = this.pending.findIndex((entry) => entry.task.id === taskId);
    if (pendingIndex !== -1) {
      const [removed] = this.pending.splice(pendingIndex, 1);
      removed.callback({
        taskId,
        success: false,
        error: 'Task cancelled before execution.',
        durationMs: 0,
        timedOut: false,
      });
      return true;
    }

    return false;
  }

  /**
   * Cancel all tasks for a specific project.
   */
  cancelByProject(projectName: string): number {
    let cancelled = 0;

    // Cancel running tasks for this project
    for (const [taskId, running] of this.running.entries()) {
      if (running.task.projectName === projectName) {
        clearTimeout(running.timeoutHandle);
        running.abortController.abort();
        cancelled++;
      }
    }

    // Remove pending tasks for this project
    const remaining: typeof this.pending = [];
    for (const entry of this.pending) {
      if (entry.task.projectName === projectName) {
        entry.callback({
          taskId: entry.task.id,
          success: false,
          error: 'Task cancelled (project-level cancellation).',
          durationMs: 0,
          timedOut: false,
        });
        cancelled++;
      } else {
        remaining.push(entry);
      }
    }
    this.pending = remaining;

    return cancelled;
  }

  /**
   * Drain the queue: stop accepting new tasks and wait for running ones to complete.
   */
  async drain(): Promise<void> {
    this.draining = true;

    // Cancel all pending
    for (const entry of this.pending) {
      entry.callback({
        taskId: entry.task.id,
        success: false,
        error: 'Queue is draining.',
        durationMs: 0,
        timedOut: false,
      });
    }
    this.pending = [];

    // Wait for running tasks to finish
    if (this.running.size > 0) {
      await new Promise<void>((resolve) => {
        const check = (): void => {
          if (this.running.size === 0) {
            resolve();
          } else {
            setTimeout(check, 100);
          }
        };
        check();
      });
    }

    this.draining = false;
  }

  /** Number of tasks waiting in the queue */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** Number of tasks currently executing */
  get runningCount(): number {
    return this.running.size;
  }

  /** Number of available execution slots */
  get availableSlots(): number {
    return Math.max(0, this.maxConcurrency - this.running.size);
  }

  /** Metrics snapshot */
  getMetrics(): {
    pending: number;
    running: number;
    maxConcurrency: number;
    runningTasks: Array<{ id: string; projectName: string; elapsedMs: number }>;
  } {
    const now = Date.now();
    return {
      pending: this.pending.length,
      running: this.running.size,
      maxConcurrency: this.maxConcurrency,
      runningTasks: Array.from(this.running.values()).map((r) => ({
        id: r.task.id,
        projectName: r.task.projectName,
        elapsedMs: now - r.startedAt,
      })),
    };
  }

  private tryRunNext(): void {
    if (this.draining) return;

    while (this.running.size < this.maxConcurrency && this.pending.length > 0) {
      const entry = this.pending.shift()!;
      this.startTask(entry.task, entry.callback);
    }
  }

  private startTask(task: QueuedTask<T>, callback: TaskResultCallback<T>): void {
    const abortController = new AbortController();
    const startedAt = Date.now();

    // Per-task timeout watchdog
    const timeoutHandle = setTimeout(() => {
      console.log(`⏰ Task ${task.id} timed out after ${task.timeoutMs}ms`);
      abortController.abort();
    }, task.timeoutMs);

    const runningTask: RunningTask<T> = {
      task,
      abortController,
      timeoutHandle,
      startedAt,
    };

    this.running.set(task.id, runningTask);

    task
      .execute(abortController.signal)
      .then((result) => {
        clearTimeout(timeoutHandle);
        this.running.delete(task.id);

        callback({
          taskId: task.id,
          success: true,
          result,
          durationMs: Date.now() - startedAt,
          timedOut: false,
        });
      })
      .catch((error) => {
        clearTimeout(timeoutHandle);
        const timedOut = abortController.signal.aborted;
        this.running.delete(task.id);

        callback({
          taskId: task.id,
          success: false,
          error: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - startedAt,
          timedOut,
        });
      })
      .finally(() => {
        this.tryRunNext();
      });
  }
}
