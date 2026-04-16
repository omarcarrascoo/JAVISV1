/**
 * Token Budget Tracker — monitors cumulative token usage per run/task
 * and emits warnings or hard-stops when limits are approached.
 */

export interface TokenBudget {
  maxTokensPerRun: number;
  maxTokensPerTask: number;
  /** Fraction (0-1) at which to emit a warning. Default 0.75. */
  warningThreshold: number;
}

export interface TokenUsageSnapshot {
  runId: string;
  taskId: string | null;
  runTotal: number;
  taskTotal: number;
  budget: TokenBudget;
  runPct: number;
  taskPct: number;
}

export type BudgetStatus = 'ok' | 'warning' | 'exceeded';

export interface BudgetCheck {
  status: BudgetStatus;
  runUsed: number;
  taskUsed: number;
  message: string | null;
}

const DEFAULT_BUDGET: TokenBudget = {
  maxTokensPerRun: 2_000_000,
  maxTokensPerTask: 500_000,
  warningThreshold: 0.75,
};

/**
 * Per-run token accumulator.
 */
export class TokenTracker {
  private runTotals = new Map<string, number>();
  private taskTotals = new Map<string, number>();
  private budget: TokenBudget;

  constructor(budget?: Partial<TokenBudget>) {
    this.budget = { ...DEFAULT_BUDGET, ...budget };
  }

  /**
   * Record token usage for a specific run/task.
   * Returns a budget check result.
   */
  record(runId: string, taskId: string | null, tokens: number): BudgetCheck {
    const runTotal = (this.runTotals.get(runId) || 0) + tokens;
    this.runTotals.set(runId, runTotal);

    let taskTotal = 0;
    if (taskId) {
      const key = `${runId}:${taskId}`;
      taskTotal = (this.taskTotals.get(key) || 0) + tokens;
      this.taskTotals.set(key, taskTotal);
    }

    return this.check(runId, taskId);
  }

  /**
   * Check budget status without recording.
   */
  check(runId: string, taskId: string | null): BudgetCheck {
    const runUsed = this.runTotals.get(runId) || 0;
    let taskUsed = 0;
    if (taskId) {
      taskUsed = this.taskTotals.get(`${runId}:${taskId}`) || 0;
    }

    const { maxTokensPerRun, maxTokensPerTask, warningThreshold } = this.budget;

    // Hard stop: task exceeded
    if (taskId && taskUsed >= maxTokensPerTask) {
      return {
        status: 'exceeded',
        runUsed,
        taskUsed,
        message: `Task ${taskId} exceeded token budget: ${taskUsed.toLocaleString()}/${maxTokensPerTask.toLocaleString()} tokens.`,
      };
    }

    // Hard stop: run exceeded
    if (runUsed >= maxTokensPerRun) {
      return {
        status: 'exceeded',
        runUsed,
        taskUsed,
        message: `Run ${runId} exceeded token budget: ${runUsed.toLocaleString()}/${maxTokensPerRun.toLocaleString()} tokens.`,
      };
    }

    // Warning: task approaching limit
    if (taskId && taskUsed >= maxTokensPerTask * warningThreshold) {
      const pct = Math.round((taskUsed / maxTokensPerTask) * 100);
      return {
        status: 'warning',
        runUsed,
        taskUsed,
        message: `Task ${taskId} at ${pct}% of token budget (${taskUsed.toLocaleString()}/${maxTokensPerTask.toLocaleString()}).`,
      };
    }

    // Warning: run approaching limit
    if (runUsed >= maxTokensPerRun * warningThreshold) {
      const pct = Math.round((runUsed / maxTokensPerRun) * 100);
      return {
        status: 'warning',
        runUsed,
        taskUsed,
        message: `Run ${runId} at ${pct}% of token budget (${runUsed.toLocaleString()}/${maxTokensPerRun.toLocaleString()}).`,
      };
    }

    return { status: 'ok', runUsed, taskUsed, message: null };
  }

  getRunUsage(runId: string): number {
    return this.runTotals.get(runId) || 0;
  }

  getTaskUsage(runId: string, taskId: string): number {
    return this.taskTotals.get(`${runId}:${taskId}`) || 0;
  }

  getSnapshot(runId: string, taskId: string | null): TokenUsageSnapshot {
    const runTotal = this.runTotals.get(runId) || 0;
    const taskTotal = taskId ? this.taskTotals.get(`${runId}:${taskId}`) || 0 : 0;

    return {
      runId,
      taskId,
      runTotal,
      taskTotal,
      budget: this.budget,
      runPct: this.budget.maxTokensPerRun > 0 ? runTotal / this.budget.maxTokensPerRun : 0,
      taskPct: taskId && this.budget.maxTokensPerTask > 0 ? taskTotal / this.budget.maxTokensPerTask : 0,
    };
  }

  clearRun(runId: string): void {
    this.runTotals.delete(runId);
    // Clear all task entries for this run
    for (const key of this.taskTotals.keys()) {
      if (key.startsWith(`${runId}:`)) {
        this.taskTotals.delete(key);
      }
    }
  }
}

/** Singleton tracker for the runtime */
let globalTracker: TokenTracker | null = null;

export function getTokenTracker(budget?: Partial<TokenBudget>): TokenTracker {
  if (!globalTracker) {
    globalTracker = new TokenTracker(budget);
  }
  return globalTracker;
}

export function resetTokenTracker(): void {
  globalTracker = null;
}
