/**
 * Telemetry — public API for structured event emission.
 *
 * Usage:
 *   import { telemetry } from './services/telemetry/index.js';
 *   telemetry.taskCompleted({ runId, taskId, projectName, ... });
 */

export { getTelemetryStore, TelemetryStore } from './telemetry-store.js';
export type { TelemetryEvent, RunCostSummary, TaskCostEntry } from './telemetry-store.js';

import { getTelemetryStore } from './telemetry-store.js';

export interface TaskTelemetryPayload {
  runId: string;
  taskId: string;
  projectName: string;
  model?: string;
  tokensTotal?: number;
  tokensInput?: number;
  tokensOutput?: number;
  durationMs?: number;
  iterations?: number;
  gatesPassed?: number;
  gatesFailed?: number;
}

export interface GateTelemetryPayload {
  runId: string;
  taskId: string | null;
  projectName: string;
  gateName: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs?: number;
}

export const telemetry = {
  taskStarted(payload: { runId: string; taskId: string; projectName: string; taskTitle: string }) {
    getTelemetryStore().emit({
      runId: payload.runId,
      taskId: payload.taskId,
      projectName: payload.projectName,
      event: 'task.started',
      durationMs: null,
      tokensInput: null,
      tokensOutput: null,
      tokensTotal: null,
      model: null,
      status: 'info',
      metadata: { taskTitle: payload.taskTitle },
    });
  },

  taskCompleted(payload: TaskTelemetryPayload) {
    getTelemetryStore().emit({
      runId: payload.runId,
      taskId: payload.taskId,
      projectName: payload.projectName,
      event: 'task.completed',
      durationMs: payload.durationMs ?? null,
      tokensInput: payload.tokensInput ?? null,
      tokensOutput: payload.tokensOutput ?? null,
      tokensTotal: payload.tokensTotal ?? null,
      model: payload.model ?? null,
      status: 'success',
      metadata: {
        iterations: payload.iterations,
        gatesPassed: payload.gatesPassed,
        gatesFailed: payload.gatesFailed,
      },
    });
  },

  taskFailed(payload: TaskTelemetryPayload & { error: string }) {
    getTelemetryStore().emit({
      runId: payload.runId,
      taskId: payload.taskId,
      projectName: payload.projectName,
      event: 'task.failed',
      durationMs: payload.durationMs ?? null,
      tokensInput: payload.tokensInput ?? null,
      tokensOutput: payload.tokensOutput ?? null,
      tokensTotal: payload.tokensTotal ?? null,
      model: payload.model ?? null,
      status: 'failure',
      metadata: { error: payload.error },
    });
  },

  gatePassed(payload: GateTelemetryPayload) {
    getTelemetryStore().emit({
      runId: payload.runId,
      taskId: payload.taskId,
      projectName: payload.projectName,
      event: `gate.${payload.gateName}`,
      durationMs: payload.durationMs ?? null,
      tokensInput: null,
      tokensOutput: null,
      tokensTotal: null,
      model: null,
      status: payload.status === 'passed' ? 'success' : payload.status === 'failed' ? 'failure' : 'info',
      metadata: { gateName: payload.gateName, gateStatus: payload.status },
    });
  },

  runStarted(payload: { runId: string; projectName: string; prompt: string; taskCount: number }) {
    getTelemetryStore().emit({
      runId: payload.runId,
      taskId: null,
      projectName: payload.projectName,
      event: 'run.started',
      durationMs: null,
      tokensInput: null,
      tokensOutput: null,
      tokensTotal: null,
      model: null,
      status: 'info',
      metadata: { prompt: payload.prompt.slice(0, 500), taskCount: payload.taskCount },
    });
  },

  runCompleted(payload: {
    runId: string;
    projectName: string;
    status: string;
    durationMs: number;
    totalTokens: number;
    tasksSucceeded: number;
    tasksFailed: number;
  }) {
    getTelemetryStore().emit({
      runId: payload.runId,
      taskId: null,
      projectName: payload.projectName,
      event: 'run.completed',
      durationMs: payload.durationMs,
      tokensInput: null,
      tokensOutput: null,
      tokensTotal: payload.totalTokens,
      model: null,
      status: payload.status === 'completed' ? 'success' : 'failure',
      metadata: {
        finalStatus: payload.status,
        tasksSucceeded: payload.tasksSucceeded,
        tasksFailed: payload.tasksFailed,
      },
    });
  },

  editApplied(payload: {
    runId: string;
    taskId: string;
    projectName: string;
    editCount: number;
    fuzzyMatchUsed: boolean;
  }) {
    getTelemetryStore().emit({
      runId: payload.runId,
      taskId: payload.taskId,
      projectName: payload.projectName,
      event: 'edit.applied',
      durationMs: null,
      tokensInput: null,
      tokensOutput: null,
      tokensTotal: null,
      model: null,
      status: 'success',
      metadata: { editCount: payload.editCount, fuzzyMatchUsed: payload.fuzzyMatchUsed },
    });
  },

  editFailed(payload: {
    runId: string;
    taskId: string;
    projectName: string;
    errorCount: number;
    errors: string[];
  }) {
    getTelemetryStore().emit({
      runId: payload.runId,
      taskId: payload.taskId,
      projectName: payload.projectName,
      event: 'edit.failed',
      durationMs: null,
      tokensInput: null,
      tokensOutput: null,
      tokensTotal: null,
      model: null,
      status: 'failure',
      metadata: { errorCount: payload.errorCount, errors: payload.errors.slice(0, 5) },
    });
  },

  redirectSpiral(payload: {
    runId: string;
    taskId: string;
    projectName: string;
    consecutiveRedirects: number;
    iterationCount: number;
    toolsStripped: boolean;
  }) {
    getTelemetryStore().emit({
      runId: payload.runId,
      taskId: payload.taskId,
      projectName: payload.projectName,
      event: 'agent.redirect_spiral',
      durationMs: null,
      tokensInput: null,
      tokensOutput: null,
      tokensTotal: null,
      model: null,
      status: payload.toolsStripped ? 'failure' : 'warning',
      metadata: {
        consecutiveRedirects: payload.consecutiveRedirects,
        iterationCount: payload.iterationCount,
        toolsStripped: payload.toolsStripped,
      },
    });
  },
};
