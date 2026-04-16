/**
 * Telemetry Store — SQLite-backed structured telemetry persistence.
 *
 * Stores typed events with duration, token usage, cost, and metadata.
 * Provides aggregate queries for dashboards and learning.
 */

import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from '../../config.js';

export interface TelemetryEvent {
  id: string;
  runId: string;
  taskId: string | null;
  projectName: string;
  event: string;
  durationMs: number | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  tokensTotal: number | null;
  costUsd: number | null;
  model: string | null;
  status: 'success' | 'failure' | 'warning' | 'info';
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface RunCostSummary {
  runId: string;
  projectName: string;
  totalTokens: number;
  totalCostUsd: number;
  taskCount: number;
  avgTokensPerTask: number;
  modelBreakdown: Array<{ model: string; tokens: number; costUsd: number }>;
}

export interface TaskCostEntry {
  taskId: string;
  taskTitle: string | null;
  totalTokens: number;
  costUsd: number;
  model: string | null;
  iterations: number;
  durationMs: number;
}

/** Approximate costs per 1M tokens (input/output averaged). */
const MODEL_COST_PER_1M: Record<string, number> = {
  'deepseek-reasoner': 2.19,
  'deepseek-chat': 0.27,
  'claude-opus-4': 75.0,
  'claude-sonnet-4': 15.0,
  'claude-haiku-4-5': 4.0,
};

function estimateCostUsd(model: string | null, totalTokens: number): number {
  if (!model || !totalTokens) return 0;
  const costPer1M = MODEL_COST_PER_1M[model] ?? 1.0;
  return (totalTokens / 1_000_000) * costPer1M;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class TelemetryStore {
  private readonly db: DatabaseSync;

  constructor(dbPath = path.join(DATA_DIR, 'unity-telemetry.sqlite')) {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS telemetry (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT,
        project_name TEXT NOT NULL,
        event TEXT NOT NULL,
        duration_ms INTEGER,
        tokens_input INTEGER,
        tokens_output INTEGER,
        tokens_total INTEGER,
        cost_usd REAL,
        model TEXT,
        status TEXT NOT NULL DEFAULT 'info',
        metadata TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_telemetry_run ON telemetry(run_id);
      CREATE INDEX IF NOT EXISTS idx_telemetry_task ON telemetry(task_id);
      CREATE INDEX IF NOT EXISTS idx_telemetry_project ON telemetry(project_name);
      CREATE INDEX IF NOT EXISTS idx_telemetry_event ON telemetry(event);
      CREATE INDEX IF NOT EXISTS idx_telemetry_created ON telemetry(created_at DESC);
    `);
  }

  emit(event: Omit<TelemetryEvent, 'id' | 'createdAt' | 'costUsd'> & { costUsd?: number }): string {
    const id = `tel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const costUsd = event.costUsd ?? estimateCostUsd(event.model, event.tokensTotal ?? 0);

    this.db
      .prepare(`
        INSERT INTO telemetry (
          id, run_id, task_id, project_name, event, duration_ms,
          tokens_input, tokens_output, tokens_total, cost_usd,
          model, status, metadata, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        event.runId,
        event.taskId ?? null,
        event.projectName,
        event.event,
        event.durationMs ?? null,
        event.tokensInput ?? null,
        event.tokensOutput ?? null,
        event.tokensTotal ?? null,
        costUsd,
        event.model ?? null,
        event.status,
        event.metadata ? JSON.stringify(event.metadata) : null,
        nowIso(),
      );

    return id;
  }

  getRunCostSummary(runId: string): RunCostSummary | null {
    const row = this.db
      .prepare(`
        SELECT
          run_id,
          project_name,
          SUM(tokens_total) as total_tokens,
          SUM(cost_usd) as total_cost_usd,
          COUNT(DISTINCT task_id) as task_count
        FROM telemetry
        WHERE run_id = ? AND tokens_total > 0
        GROUP BY run_id
      `)
      .get(runId) as Record<string, unknown> | undefined;

    if (!row) return null;

    const modelRows = this.db
      .prepare(`
        SELECT
          model,
          SUM(tokens_total) as tokens,
          SUM(cost_usd) as cost_usd
        FROM telemetry
        WHERE run_id = ? AND model IS NOT NULL AND tokens_total > 0
        GROUP BY model
        ORDER BY tokens DESC
      `)
      .all(runId) as Array<Record<string, unknown>>;

    const totalTokens = Number(row.total_tokens) || 0;
    const taskCount = Number(row.task_count) || 1;

    return {
      runId,
      projectName: String(row.project_name),
      totalTokens,
      totalCostUsd: Number(row.total_cost_usd) || 0,
      taskCount,
      avgTokensPerTask: Math.round(totalTokens / taskCount),
      modelBreakdown: modelRows.map((r) => ({
        model: String(r.model),
        tokens: Number(r.tokens) || 0,
        costUsd: Number(r.cost_usd) || 0,
      })),
    };
  }

  getTaskCosts(runId: string): TaskCostEntry[] {
    const rows = this.db
      .prepare(`
        SELECT
          task_id,
          SUM(tokens_total) as total_tokens,
          SUM(cost_usd) as cost_usd,
          MAX(model) as model,
          COUNT(*) as iterations,
          SUM(duration_ms) as duration_ms
        FROM telemetry
        WHERE run_id = ? AND task_id IS NOT NULL AND tokens_total > 0
        GROUP BY task_id
        ORDER BY total_tokens DESC
      `)
      .all(runId) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      taskId: String(r.task_id),
      taskTitle: null,
      totalTokens: Number(r.total_tokens) || 0,
      costUsd: Number(r.cost_usd) || 0,
      model: r.model ? String(r.model) : null,
      iterations: Number(r.iterations) || 0,
      durationMs: Number(r.duration_ms) || 0,
    }));
  }

  listEventsByRun(runId: string, limit = 200): TelemetryEvent[] {
    const rows = this.db
      .prepare(`SELECT * FROM telemetry WHERE run_id = ? ORDER BY created_at ASC LIMIT ?`)
      .all(runId, limit) as Array<Record<string, unknown>>;

    return rows.map(mapTelemetryEvent);
  }

  getProjectStats(projectName: string, days = 30): {
    totalRuns: number;
    totalTokens: number;
    totalCostUsd: number;
    avgTokensPerRun: number;
    successRate: number;
  } {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const row = this.db
      .prepare(`
        SELECT
          COUNT(DISTINCT run_id) as total_runs,
          SUM(tokens_total) as total_tokens,
          SUM(cost_usd) as total_cost_usd,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
          COUNT(*) as total_events
        FROM telemetry
        WHERE project_name = ? AND created_at >= ?
      `)
      .get(projectName, cutoff) as Record<string, unknown>;

    const totalRuns = Number(row.total_runs) || 0;
    const totalTokens = Number(row.total_tokens) || 0;
    const successCount = Number(row.success_count) || 0;
    const totalEvents = Number(row.total_events) || 1;

    return {
      totalRuns,
      totalTokens,
      totalCostUsd: Number(row.total_cost_usd) || 0,
      avgTokensPerRun: totalRuns > 0 ? Math.round(totalTokens / totalRuns) : 0,
      successRate: totalEvents > 0 ? successCount / totalEvents : 0,
    };
  }

  close(): void {
    this.db.close();
  }
}

function mapTelemetryEvent(row: Record<string, unknown>): TelemetryEvent {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    taskId: row.task_id ? String(row.task_id) : null,
    projectName: String(row.project_name),
    event: String(row.event),
    durationMs: row.duration_ms != null ? Number(row.duration_ms) : null,
    tokensInput: row.tokens_input != null ? Number(row.tokens_input) : null,
    tokensOutput: row.tokens_output != null ? Number(row.tokens_output) : null,
    tokensTotal: row.tokens_total != null ? Number(row.tokens_total) : null,
    costUsd: row.cost_usd != null ? Number(row.cost_usd) : null,
    model: row.model ? String(row.model) : null,
    status: String(row.status) as TelemetryEvent['status'],
    metadata: row.metadata ? JSON.parse(String(row.metadata)) : null,
    createdAt: String(row.created_at),
  };
}

/** Singleton */
let instance: TelemetryStore | null = null;

export function getTelemetryStore(): TelemetryStore {
  if (!instance) {
    instance = new TelemetryStore();
  }
  return instance;
}
