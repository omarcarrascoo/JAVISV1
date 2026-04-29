import { getRuntimeConfig, getProjectByName } from '../config.js';
import type { WorkspaceProject } from '../domain/runtime.js';
import { TaskQueue } from './task-queue.js';

interface SessionRecord {
  commitMessage: string;
  projectName: string;
}

interface ActiveRun {
  runId: string;
  projectName: string;
  abortController: AbortController;
  startedAt: number;
}

const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes per task

export class RuntimeState {
  private activeProjectName: string;
  private readonly sessionStore = new Map<string, SessionRecord>();
  private readonly activeRuns = new Map<string, ActiveRun>();
  readonly taskQueue: TaskQueue;

  constructor(initialProjectName = getRuntimeConfig().githubRepo) {
    this.activeProjectName = initialProjectName;
    this.taskQueue = new TaskQueue(6); // Up to 6 concurrent slots across all projects
  }

  /* ── Project management ── */

  getActiveProject(): WorkspaceProject {
    return getProjectByName(this.activeProjectName);
  }

  setActiveProject(repoName: string): WorkspaceProject {
    this.activeProjectName = repoName;
    return this.getActiveProject();
  }

  getActiveProjectName(): string {
    return this.activeProjectName;
  }

  /* ── Processing state (backward-compatible) ── */

  isProcessing(): boolean {
    return this.activeRuns.size > 0;
  }

  isProjectProcessing(projectName: string): boolean {
    for (const run of this.activeRuns.values()) {
      if (run.projectName === projectName) return true;
    }
    return false;
  }

  /**
   * Start processing for a specific run. Returns an AbortController.
   * Multiple runs can execute concurrently (cross-project or same project).
   *
   * When called without arguments (legacy), uses a generated ID and the active project.
   */
  startProcessing(runId?: string, projectName?: string): AbortController {
    const effectiveRunId = runId || `legacy-${Date.now()}`;
    const effectiveProject = projectName || this.activeProjectName;

    if (this.activeRuns.has(effectiveRunId)) {
      throw new Error(`Run ${effectiveRunId} is already processing.`);
    }

    const abortController = new AbortController();
    this.activeRuns.set(effectiveRunId, {
      runId: effectiveRunId,
      projectName: effectiveProject,
      abortController,
      startedAt: Date.now(),
    });

    return abortController;
  }

  finishProcessing(runId?: string): void {
    if (runId) {
      this.activeRuns.delete(runId);
    } else {
      // Legacy: clear all (backward compat)
      this.activeRuns.clear();
    }
  }

  abortCurrentTask(runId?: string): boolean {
    if (runId) {
      const run = this.activeRuns.get(runId);
      if (run) {
        run.abortController.abort();
        return true;
      }
      return false;
    }

    // Legacy: abort first active run
    const firstRun = this.activeRuns.values().next();
    if (!firstRun.done) {
      firstRun.value.abortController.abort();
      return true;
    }
    return false;
  }

  abortByProject(projectName: string): number {
    let aborted = 0;
    for (const [runId, run] of this.activeRuns.entries()) {
      if (run.projectName === projectName) {
        run.abortController.abort();
        aborted++;
      }
    }
    this.taskQueue.cancelByProject(projectName);
    return aborted;
  }

  getAbortSignal(runId?: string): AbortSignal | undefined {
    if (runId) {
      return this.activeRuns.get(runId)?.abortController.signal;
    }
    // Legacy: return first active run's signal
    const firstRun = this.activeRuns.values().next();
    return firstRun.done ? undefined : firstRun.value.abortController.signal;
  }

  getActiveRunIds(): string[] {
    return Array.from(this.activeRuns.keys());
  }

  getActiveRunCount(): number {
    return this.activeRuns.size;
  }

  getQueueMetrics(): {
    activeRuns: number;
    queuePending: number;
    queueRunning: number;
    queueMaxConcurrency: number;
  } {
    const queueMetrics = this.taskQueue.getMetrics();
    return {
      activeRuns: this.activeRuns.size,
      queuePending: queueMetrics.pending,
      queueRunning: queueMetrics.running,
      queueMaxConcurrency: queueMetrics.maxConcurrency,
    };
  }

  /* ── Session store ── */

  rememberSession(sessionId: string, commitMessage: string, projectName: string): void {
    this.sessionStore.set(sessionId, { commitMessage, projectName });
  }

  getSessionRecord(sessionId: string): SessionRecord | undefined {
    return this.sessionStore.get(sessionId);
  }

  deleteSession(sessionId: string): void {
    this.sessionStore.delete(sessionId);
  }
}
