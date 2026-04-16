/**
 * Learning Store — SQLite-backed pattern persistence and effectiveness tracking.
 *
 * Stores what worked (and what didn't) across runs so the agent can
 * learn from past experience and avoid repeating mistakes.
 */

import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from '../../config.js';

/* ── Domain Types ── */

export interface LearnedPattern {
  id: string;
  projectName: string;
  /** Task kind: implement, improve, heal, fix, refactor */
  taskKind: string;
  /** Glob-style file pattern scope (e.g. "src/api/**", "src/components/**") */
  filePattern: string;
  /** Keyword tags extracted from the task (e.g. ["auth", "middleware", "jwt"]) */
  tags: string[];
  /** Natural language summary of the approach that worked */
  approach: string;
  /** How many agent iterations the task took */
  iterations: number;
  /** Token count for the successful execution */
  tokensUsed: number;
  /** Key files that were read during exploration */
  filesRead: string[];
  /** Key files that were edited */
  filesEdited: string[];
  /** Tools used most frequently */
  topTools: string[];
  /** Number of times this pattern has been applied to future tasks */
  timesApplied: number;
  /** Number of times a task succeeded when this pattern was injected */
  timesSucceeded: number;
  /** Number of times a task failed when this pattern was injected */
  timesFailed: number;
  /** Effectiveness score: (timesSucceeded - timesFailed) / timesApplied */
  effectivenessScore: number;
  /** Source: which run/task produced this pattern */
  sourceRunId: string;
  sourceTaskId: string;
  createdAt: string;
  updatedAt: string;
}

export interface PatternMatch {
  pattern: LearnedPattern;
  relevanceScore: number;
  matchReasons: string[];
}

export interface TaskOutcome {
  patternId: string;
  taskId: string;
  runId: string;
  succeeded: boolean;
  iterations: number;
  tokensUsed: number;
  createdAt: string;
}

/* ── Store ── */

function nowIso(): string {
  return new Date().toISOString();
}

export class LearningStore {
  private readonly db: DatabaseSync;

  constructor(dbPath = path.join(DATA_DIR, 'unity-learning.sqlite')) {
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
      CREATE TABLE IF NOT EXISTS patterns (
        id TEXT PRIMARY KEY,
        project_name TEXT NOT NULL,
        task_kind TEXT NOT NULL,
        file_pattern TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        approach TEXT NOT NULL,
        iterations INTEGER NOT NULL,
        tokens_used INTEGER NOT NULL,
        files_read TEXT NOT NULL DEFAULT '[]',
        files_edited TEXT NOT NULL DEFAULT '[]',
        top_tools TEXT NOT NULL DEFAULT '[]',
        times_applied INTEGER NOT NULL DEFAULT 0,
        times_succeeded INTEGER NOT NULL DEFAULT 0,
        times_failed INTEGER NOT NULL DEFAULT 0,
        effectiveness_score REAL NOT NULL DEFAULT 0.0,
        source_run_id TEXT NOT NULL,
        source_task_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_patterns_project ON patterns(project_name);
      CREATE INDEX IF NOT EXISTS idx_patterns_kind ON patterns(task_kind);
      CREATE INDEX IF NOT EXISTS idx_patterns_effectiveness ON patterns(effectiveness_score DESC);
      CREATE INDEX IF NOT EXISTS idx_patterns_file_pattern ON patterns(file_pattern);

      CREATE TABLE IF NOT EXISTS pattern_outcomes (
        id TEXT PRIMARY KEY,
        pattern_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        succeeded INTEGER NOT NULL,
        iterations INTEGER NOT NULL DEFAULT 0,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_outcomes_pattern ON pattern_outcomes(pattern_id);
      CREATE INDEX IF NOT EXISTS idx_outcomes_task ON pattern_outcomes(task_id);
    `);
  }

  /* ── Pattern CRUD ── */

  savePattern(pattern: Omit<LearnedPattern, 'timesApplied' | 'timesSucceeded' | 'timesFailed' | 'effectivenessScore' | 'updatedAt'>): string {
    const id = pattern.id;

    this.db
      .prepare(`
        INSERT INTO patterns (
          id, project_name, task_kind, file_pattern, tags, approach,
          iterations, tokens_used, files_read, files_edited, top_tools,
          times_applied, times_succeeded, times_failed, effectiveness_score,
          source_run_id, source_task_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0.0, ?, ?, ?, ?)
      `)
      .run(
        id,
        pattern.projectName,
        pattern.taskKind,
        pattern.filePattern,
        JSON.stringify(pattern.tags),
        pattern.approach,
        pattern.iterations,
        pattern.tokensUsed,
        JSON.stringify(pattern.filesRead),
        JSON.stringify(pattern.filesEdited),
        JSON.stringify(pattern.topTools),
        pattern.sourceRunId,
        pattern.sourceTaskId,
        pattern.createdAt,
        nowIso(),
      );

    return id;
  }

  getPattern(id: string): LearnedPattern | null {
    const row = this.db.prepare('SELECT * FROM patterns WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? mapPattern(row) : null;
  }

  /**
   * Find patterns relevant to a given task context.
   * Scoring factors: project match, task kind match, file scope overlap, tag overlap, effectiveness.
   */
  findRelevantPatterns(params: {
    projectName: string;
    taskKind: string;
    writeScope: string[];
    promptKeywords: string[];
    limit?: number;
  }): PatternMatch[] {
    const limit = params.limit ?? 5;

    // Pull candidate patterns: same project OR highly effective cross-project
    const candidates = this.db
      .prepare(`
        SELECT * FROM patterns
        WHERE (project_name = ? OR effectiveness_score > 0.7)
          AND effectiveness_score >= -0.3
        ORDER BY effectiveness_score DESC, times_applied DESC
        LIMIT 100
      `)
      .all(params.projectName) as Array<Record<string, unknown>>;

    const scored: PatternMatch[] = [];

    for (const row of candidates) {
      const pattern = mapPattern(row);
      const { score, reasons } = scorePatternRelevance(pattern, params);

      if (score > 0) {
        scored.push({ pattern, relevanceScore: score, matchReasons: reasons });
      }
    }

    // Sort by relevance, then effectiveness
    scored.sort((a, b) => {
      const relevanceDiff = b.relevanceScore - a.relevanceScore;
      if (Math.abs(relevanceDiff) > 0.1) return relevanceDiff;
      return b.pattern.effectivenessScore - a.pattern.effectivenessScore;
    });

    return scored.slice(0, limit);
  }

  /* ── Outcome Tracking ── */

  /**
   * Record that a pattern was applied to a task and whether it succeeded.
   * Updates the pattern's effectiveness score.
   */
  recordOutcome(params: {
    patternId: string;
    taskId: string;
    runId: string;
    succeeded: boolean;
    iterations: number;
    tokensUsed: number;
  }): void {
    const outcomeId = `out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    this.db
      .prepare(`
        INSERT INTO pattern_outcomes (id, pattern_id, task_id, run_id, succeeded, iterations, tokens_used, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        outcomeId,
        params.patternId,
        params.taskId,
        params.runId,
        params.succeeded ? 1 : 0,
        params.iterations,
        params.tokensUsed,
        nowIso(),
      );

    // Update pattern stats
    const field = params.succeeded ? 'times_succeeded' : 'times_failed';
    this.db
      .prepare(`
        UPDATE patterns SET
          times_applied = times_applied + 1,
          ${field} = ${field} + 1,
          effectiveness_score = CASE
            WHEN (times_applied + 1) > 0
            THEN CAST((times_succeeded + ${params.succeeded ? 1 : 0}) - (times_failed + ${params.succeeded ? 0 : 1}) AS REAL)
                 / (times_applied + 1)
            ELSE 0.0
          END,
          updated_at = ?
        WHERE id = ?
      `)
      .run(nowIso(), params.patternId);
  }

  /**
   * Get outcome history for a pattern.
   */
  getPatternOutcomes(patternId: string): TaskOutcome[] {
    const rows = this.db
      .prepare('SELECT * FROM pattern_outcomes WHERE pattern_id = ? ORDER BY created_at DESC LIMIT 50')
      .all(patternId) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      patternId: String(r.pattern_id),
      taskId: String(r.task_id),
      runId: String(r.run_id),
      succeeded: Number(r.succeeded) === 1,
      iterations: Number(r.iterations),
      tokensUsed: Number(r.tokens_used),
      createdAt: String(r.created_at),
    }));
  }

  /* ── Pruning ── */

  /**
   * Remove patterns that have been tried enough times but consistently fail.
   * Returns the number of patterns pruned.
   */
  pruneIneffectivePatterns(minApplied = 3, minScore = -0.5): number {
    const result = this.db
      .prepare(`
        DELETE FROM patterns
        WHERE times_applied >= ? AND effectiveness_score < ?
      `)
      .run(minApplied, minScore);

    return Number(result.changes);
  }

  /**
   * Remove duplicate patterns (same project, kind, file_pattern, similar approach).
   * Keeps the one with the highest effectiveness score.
   */
  deduplicatePatterns(): number {
    // Find groups with same project + kind + file_pattern
    const groups = this.db
      .prepare(`
        SELECT project_name, task_kind, file_pattern, COUNT(*) as cnt
        FROM patterns
        GROUP BY project_name, task_kind, file_pattern
        HAVING cnt > 1
      `)
      .all() as Array<Record<string, unknown>>;

    let pruned = 0;

    for (const group of groups) {
      const patterns = this.db
        .prepare(`
          SELECT id, effectiveness_score FROM patterns
          WHERE project_name = ? AND task_kind = ? AND file_pattern = ?
          ORDER BY effectiveness_score DESC
        `)
        .all(String(group.project_name), String(group.task_kind), String(group.file_pattern)) as Array<Record<string, unknown>>;

      // Keep the best, delete the rest
      for (let i = 1; i < patterns.length; i++) {
        this.db.prepare('DELETE FROM patterns WHERE id = ?').run(String(patterns[i].id));
        pruned++;
      }
    }

    return pruned;
  }

  /**
   * Get top patterns across all projects for the dashboard.
   */
  getTopPatterns(limit = 20): LearnedPattern[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM patterns
        WHERE times_applied >= 1
        ORDER BY effectiveness_score DESC, times_applied DESC
        LIMIT ?
      `)
      .all(limit) as Array<Record<string, unknown>>;

    return rows.map(mapPattern);
  }

  /**
   * Get learning stats for a project.
   */
  getProjectLearningStats(projectName: string): {
    totalPatterns: number;
    effectivePatterns: number;
    totalApplications: number;
    overallSuccessRate: number;
    avgIterationsLearned: number;
    avgIterationsBaseline: number;
  } {
    const row = this.db
      .prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN effectiveness_score > 0 THEN 1 ELSE 0 END) as effective,
          SUM(times_applied) as applications,
          SUM(times_succeeded) as successes,
          SUM(times_failed) as failures,
          AVG(iterations) as avg_iterations
        FROM patterns
        WHERE project_name = ?
      `)
      .get(projectName) as Record<string, unknown>;

    const totalApplications = Number(row.applications) || 0;
    const successes = Number(row.successes) || 0;

    return {
      totalPatterns: Number(row.total) || 0,
      effectivePatterns: Number(row.effective) || 0,
      totalApplications,
      overallSuccessRate: totalApplications > 0 ? successes / totalApplications : 0,
      avgIterationsLearned: Number(row.avg_iterations) || 0,
      avgIterationsBaseline: 0, // Would need telemetry comparison
    };
  }

  close(): void {
    this.db.close();
  }
}

/* ── Helpers ── */

function mapPattern(row: Record<string, unknown>): LearnedPattern {
  return {
    id: String(row.id),
    projectName: String(row.project_name),
    taskKind: String(row.task_kind),
    filePattern: String(row.file_pattern),
    tags: safeParseJson(row.tags, []),
    approach: String(row.approach),
    iterations: Number(row.iterations),
    tokensUsed: Number(row.tokens_used),
    filesRead: safeParseJson(row.files_read, []),
    filesEdited: safeParseJson(row.files_edited, []),
    topTools: safeParseJson(row.top_tools, []),
    timesApplied: Number(row.times_applied),
    timesSucceeded: Number(row.times_succeeded),
    timesFailed: Number(row.times_failed),
    effectivenessScore: Number(row.effectiveness_score),
    sourceRunId: String(row.source_run_id),
    sourceTaskId: String(row.source_task_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function safeParseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/**
 * Score how relevant a pattern is to a given task context.
 * Returns a score 0-1 and reasons for the match.
 */
function scorePatternRelevance(
  pattern: LearnedPattern,
  params: {
    projectName: string;
    taskKind: string;
    writeScope: string[];
    promptKeywords: string[];
  },
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  // Project match (strong signal)
  if (pattern.projectName === params.projectName) {
    score += 0.3;
    reasons.push('same project');
  }

  // Task kind match
  if (pattern.taskKind === params.taskKind) {
    score += 0.2;
    reasons.push(`kind: ${params.taskKind}`);
  }

  // File scope overlap
  const scopeOverlap = computeScopeOverlap(pattern.filePattern, pattern.filesEdited, params.writeScope);
  if (scopeOverlap > 0) {
    score += 0.25 * scopeOverlap;
    reasons.push(`scope overlap: ${Math.round(scopeOverlap * 100)}%`);
  }

  // Tag/keyword overlap
  const tagOverlap = computeTagOverlap(pattern.tags, params.promptKeywords);
  if (tagOverlap > 0) {
    score += 0.25 * tagOverlap;
    reasons.push(`keyword overlap: ${Math.round(tagOverlap * 100)}%`);
  }

  // Effectiveness bonus/penalty
  if (pattern.timesApplied >= 2) {
    score += 0.1 * pattern.effectivenessScore;
    if (pattern.effectivenessScore > 0.5) {
      reasons.push(`proven effective (${Math.round(pattern.effectivenessScore * 100)}%)`);
    }
  }

  return { score: Math.min(1, Math.max(0, score)), reasons };
}

function computeScopeOverlap(
  patternFileGlob: string,
  patternFilesEdited: string[],
  taskWriteScope: string[],
): number {
  if (!taskWriteScope.length || taskWriteScope.includes('.')) return 0.3; // weak match for broad scope

  let matches = 0;
  const total = taskWriteScope.length;

  for (const scope of taskWriteScope) {
    // Check if the pattern's file glob or edited files overlap with this scope
    if (patternFileGlob.includes(scope) || scope.includes(patternFileGlob.split('*')[0])) {
      matches++;
      continue;
    }
    // Check if any edited files are in this scope
    if (patternFilesEdited.some((f) => f.startsWith(scope) || scope.startsWith(f.split('/')[0]))) {
      matches++;
    }
  }

  return total > 0 ? matches / total : 0;
}

function computeTagOverlap(patternTags: string[], keywords: string[]): number {
  if (!patternTags.length || !keywords.length) return 0;

  const patternSet = new Set(patternTags.map((t) => t.toLowerCase()));
  let matches = 0;

  for (const kw of keywords) {
    const lower = kw.toLowerCase();
    if (patternSet.has(lower)) {
      matches++;
      continue;
    }
    // Partial match: keyword is a substring of a tag or vice versa
    for (const tag of patternSet) {
      if (tag.includes(lower) || lower.includes(tag)) {
        matches += 0.5;
        break;
      }
    }
  }

  return Math.min(1, matches / keywords.length);
}

/** Singleton */
let instance: LearningStore | null = null;

export function getLearningStore(): LearningStore {
  if (!instance) {
    instance = new LearningStore();
  }
  return instance;
}
