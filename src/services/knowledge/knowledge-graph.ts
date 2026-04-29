/**
 * Knowledge Graph — persistent, evolving understanding of project architecture.
 *
 * Tracks:
 * - Module boundaries and ownership
 * - API surface area and consumers
 * - Historical change frequency (hot files)
 * - Known fragile areas and common failure modes
 * - Architecture decisions and rationale
 *
 * Updated automatically after each run, consulted before planning.
 */

import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from '../../config.js';
import { buildImportGraph } from '../../shared/import-graph.js';

/* ── Domain Types ── */

export interface ModuleNode {
  id: string;
  projectName: string;
  /** Module path relative to repo root (e.g. "src/services/auth", "src/components/ui") */
  modulePath: string;
  /** Module type classification */
  moduleType: 'service' | 'component' | 'util' | 'config' | 'test' | 'route' | 'domain' | 'infra';
  /** Key exports from this module */
  exports: string[];
  /** Modules that this module imports from */
  dependencies: string[];
  /** Modules that import from this module */
  dependents: string[];
  /** Number of times files in this module were changed across runs */
  changeFrequency: number;
  /** Number of times changes to this module caused gate failures */
  failureFrequency: number;
  /** Fragility score: failureFrequency / changeFrequency (higher = more fragile) */
  fragilityScore: number;
  /** Architecture notes (decisions, constraints, known issues) */
  notes: string[];
  updatedAt: string;
}

export interface ApiEndpoint {
  id: string;
  projectName: string;
  /** HTTP method or event type */
  method: string;
  /** Route path or event name */
  path: string;
  /** Source file that defines this endpoint */
  sourceFile: string;
  /** Modules that consume this endpoint */
  consumers: string[];
  updatedAt: string;
}

export interface ArchitectureDecision {
  id: string;
  projectName: string;
  /** Short title */
  title: string;
  /** Full description of the decision */
  description: string;
  /** What prompted this decision */
  context: string;
  /** Files or modules affected */
  affectedPaths: string[];
  /** When this decision was recorded */
  createdAt: string;
  /** Source: which run produced this insight */
  sourceRunId: string | null;
}

export interface KnowledgeSnapshot {
  modules: ModuleNode[];
  hotFiles: Array<{ path: string; changeCount: number; failureCount: number }>;
  fragileAreas: Array<{ modulePath: string; fragilityScore: number; notes: string[] }>;
  apiEndpoints: ApiEndpoint[];
  decisions: ArchitectureDecision[];
}

/* ── Store ── */

function nowIso(): string {
  return new Date().toISOString();
}

export class KnowledgeGraphStore {
  private db: DatabaseSync;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath || path.join(DATA_DIR, 'unity-knowledge.sqlite');
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new DatabaseSync(resolvedPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS modules (
        id TEXT PRIMARY KEY,
        project_name TEXT NOT NULL,
        module_path TEXT NOT NULL,
        module_type TEXT NOT NULL DEFAULT 'util',
        exports TEXT NOT NULL DEFAULT '[]',
        dependencies TEXT NOT NULL DEFAULT '[]',
        dependents TEXT NOT NULL DEFAULT '[]',
        change_frequency INTEGER NOT NULL DEFAULT 0,
        failure_frequency INTEGER NOT NULL DEFAULT 0,
        notes TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_modules_project_path
        ON modules (project_name, module_path);

      CREATE TABLE IF NOT EXISTS api_endpoints (
        id TEXT PRIMARY KEY,
        project_name TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        source_file TEXT NOT NULL,
        consumers TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_api_project
        ON api_endpoints (project_name);

      CREATE TABLE IF NOT EXISTS architecture_decisions (
        id TEXT PRIMARY KEY,
        project_name TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '',
        affected_paths TEXT NOT NULL DEFAULT '[]',
        source_run_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_decisions_project
        ON architecture_decisions (project_name);

      CREATE TABLE IF NOT EXISTS file_change_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        run_id TEXT NOT NULL,
        task_id TEXT,
        change_type TEXT NOT NULL DEFAULT 'modify',
        gate_passed INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_changes_project_file
        ON file_change_log (project_name, file_path);

      CREATE INDEX IF NOT EXISTS idx_changes_run
        ON file_change_log (run_id);
    `);
  }

  /* ── Module Operations ── */

  upsertModule(projectName: string, modulePath: string, data: Partial<ModuleNode>): void {
    const existing = this.db
      .prepare('SELECT id FROM modules WHERE project_name = ? AND module_path = ?')
      .get(projectName, modulePath) as { id: string } | undefined;

    if (existing) {
      const sets: string[] = [];
      const values: (string | number | null)[] = [];

      if (data.moduleType) { sets.push('module_type = ?'); values.push(data.moduleType); }
      if (data.exports) { sets.push('exports = ?'); values.push(JSON.stringify(data.exports)); }
      if (data.dependencies) { sets.push('dependencies = ?'); values.push(JSON.stringify(data.dependencies)); }
      if (data.dependents) { sets.push('dependents = ?'); values.push(JSON.stringify(data.dependents)); }
      if (data.notes) { sets.push('notes = ?'); values.push(JSON.stringify(data.notes)); }

      sets.push('updated_at = ?');
      values.push(nowIso());
      values.push(existing.id);

      if (sets.length > 1) {
        this.db.prepare(`UPDATE modules SET ${sets.join(', ')} WHERE id = ?`).run(...values);
      }
    } else {
      const id = `mod_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      this.db
        .prepare(
          `INSERT INTO modules (id, project_name, module_path, module_type, exports, dependencies, dependents, notes, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          projectName,
          modulePath,
          data.moduleType || 'util',
          JSON.stringify(data.exports || []),
          JSON.stringify(data.dependencies || []),
          JSON.stringify(data.dependents || []),
          JSON.stringify(data.notes || []),
          nowIso(),
        );
    }
  }

  getModule(projectName: string, modulePath: string): ModuleNode | null {
    const row = this.db
      .prepare('SELECT * FROM modules WHERE project_name = ? AND module_path = ?')
      .get(projectName, modulePath) as Record<string, unknown> | undefined;

    return row ? mapModuleRow(row) : null;
  }

  listModules(projectName: string): ModuleNode[] {
    const rows = this.db
      .prepare('SELECT * FROM modules WHERE project_name = ? ORDER BY change_frequency DESC')
      .all(projectName) as Array<Record<string, unknown>>;

    return rows.map(mapModuleRow);
  }

  incrementModuleChanges(projectName: string, modulePath: string, gatePassed: boolean): void {
    this.db
      .prepare(
        `UPDATE modules SET
          change_frequency = change_frequency + 1,
          failure_frequency = failure_frequency + CASE WHEN ? = 0 THEN 1 ELSE 0 END,
          updated_at = ?
         WHERE project_name = ? AND module_path = ?`,
      )
      .run(gatePassed ? 1 : 0, nowIso(), projectName, modulePath);
  }

  /* ── File Change Tracking ── */

  recordFileChange(params: {
    projectName: string;
    filePath: string;
    runId: string;
    taskId?: string;
    changeType?: 'create' | 'modify' | 'delete';
    gatePassed?: boolean;
  }): void {
    this.db
      .prepare(
        `INSERT INTO file_change_log (project_name, file_path, run_id, task_id, change_type, gate_passed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.projectName,
        params.filePath,
        params.runId,
        params.taskId || null,
        params.changeType || 'modify',
        params.gatePassed !== false ? 1 : 0,
        nowIso(),
      );
  }

  getHotFiles(projectName: string, limit = 20): Array<{ path: string; changeCount: number; failureCount: number }> {
    const rows = this.db
      .prepare(
        `SELECT
          file_path,
          COUNT(*) as change_count,
          SUM(CASE WHEN gate_passed = 0 THEN 1 ELSE 0 END) as failure_count
         FROM file_change_log
         WHERE project_name = ?
         GROUP BY file_path
         ORDER BY change_count DESC
         LIMIT ?`,
      )
      .all(projectName, limit) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      path: String(r.file_path),
      changeCount: Number(r.change_count) || 0,
      failureCount: Number(r.failure_count) || 0,
    }));
  }

  getFragileAreas(projectName: string, limit = 10): Array<{ modulePath: string; fragilityScore: number; notes: string[] }> {
    const rows = this.db
      .prepare(
        `SELECT module_path, change_frequency, failure_frequency, notes
         FROM modules
         WHERE project_name = ? AND change_frequency > 0
         ORDER BY (CAST(failure_frequency AS REAL) / change_frequency) DESC
         LIMIT ?`,
      )
      .all(projectName, limit) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      modulePath: String(r.module_path),
      fragilityScore:
        Number(r.change_frequency) > 0
          ? Number(r.failure_frequency) / Number(r.change_frequency)
          : 0,
      notes: parseJsonSafe<string[]>(r.notes, []),
    }));
  }

  /* ── API Endpoints ── */

  upsertApiEndpoint(projectName: string, method: string, apiPath: string, sourceFile: string): void {
    const existing = this.db
      .prepare('SELECT id FROM api_endpoints WHERE project_name = ? AND method = ? AND path = ?')
      .get(projectName, method, apiPath) as { id: string } | undefined;

    if (existing) {
      this.db
        .prepare('UPDATE api_endpoints SET source_file = ?, updated_at = ? WHERE id = ?')
        .run(sourceFile, nowIso(), existing.id);
    } else {
      const id = `api_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      this.db
        .prepare(
          'INSERT INTO api_endpoints (id, project_name, method, path, source_file, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(id, projectName, method, apiPath, sourceFile, nowIso());
    }
  }

  listApiEndpoints(projectName: string): ApiEndpoint[] {
    const rows = this.db
      .prepare('SELECT * FROM api_endpoints WHERE project_name = ? ORDER BY path')
      .all(projectName) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: String(r.id),
      projectName: String(r.project_name),
      method: String(r.method),
      path: String(r.path),
      sourceFile: String(r.source_file),
      consumers: parseJsonSafe<string[]>(r.consumers, []),
      updatedAt: String(r.updated_at),
    }));
  }

  /* ── Architecture Decisions ── */

  addDecision(params: {
    projectName: string;
    title: string;
    description: string;
    context?: string;
    affectedPaths?: string[];
    sourceRunId?: string;
  }): string {
    const id = `adr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.db
      .prepare(
        `INSERT INTO architecture_decisions (id, project_name, title, description, context, affected_paths, source_run_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.projectName,
        params.title,
        params.description,
        params.context || '',
        JSON.stringify(params.affectedPaths || []),
        params.sourceRunId || null,
        nowIso(),
      );
    return id;
  }

  listDecisions(projectName: string, limit = 20): ArchitectureDecision[] {
    const rows = this.db
      .prepare('SELECT * FROM architecture_decisions WHERE project_name = ? ORDER BY created_at DESC LIMIT ?')
      .all(projectName, limit) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: String(r.id),
      projectName: String(r.project_name),
      title: String(r.title),
      description: String(r.description),
      context: String(r.context),
      affectedPaths: parseJsonSafe<string[]>(r.affected_paths, []),
      sourceRunId: (r.source_run_id as string) || null,
      createdAt: String(r.created_at),
    }));
  }

  /* ── File Change Attribution ── */

  getFileChangesWithAttribution(
    projectName: string,
    limit = 50,
  ): Array<{
    filePath: string;
    runId: string;
    taskId: string | null;
    changeType: string;
    gatePassed: boolean;
    createdAt: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT file_path, run_id, task_id, change_type, gate_passed, created_at
         FROM file_change_log
         WHERE project_name = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(projectName, limit) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      filePath: String(r.file_path),
      runId: String(r.run_id),
      taskId: r.task_id ? String(r.task_id) : null,
      changeType: String(r.change_type),
      gatePassed: Number(r.gate_passed) === 1,
      createdAt: String(r.created_at),
    }));
  }

  /* ── Full Snapshot (for planner injection) ── */

  getProjectSnapshot(projectName: string): KnowledgeSnapshot {
    return {
      modules: this.listModules(projectName),
      hotFiles: this.getHotFiles(projectName),
      fragileAreas: this.getFragileAreas(projectName),
      apiEndpoints: this.listApiEndpoints(projectName),
      decisions: this.listDecisions(projectName, 10),
    };
  }

  /**
   * Build a concise text summary of the knowledge graph for prompt injection.
   * Designed to fit within ~2000 tokens of context.
   */
  buildPromptContext(projectName: string): string | null {
    const snapshot = this.getProjectSnapshot(projectName);

    if (
      snapshot.modules.length === 0 &&
      snapshot.hotFiles.length === 0 &&
      snapshot.decisions.length === 0
    ) {
      return null;
    }

    const sections: string[] = [];

    if (snapshot.fragileAreas.length > 0) {
      const fragile = snapshot.fragileAreas
        .filter((a) => a.fragilityScore > 0.2)
        .slice(0, 5)
        .map((a) => `  - ${a.modulePath} (fragility: ${(a.fragilityScore * 100).toFixed(0)}%${a.notes.length ? ` — ${a.notes[0]}` : ''})`)
        .join('\n');
      if (fragile) sections.push(`FRAGILE AREAS (proceed with caution):\n${fragile}`);
    }

    if (snapshot.hotFiles.length > 0) {
      const hot = snapshot.hotFiles
        .slice(0, 8)
        .map((f) => `  - ${f.path} (${f.changeCount} changes, ${f.failureCount} failures)`)
        .join('\n');
      sections.push(`FREQUENTLY CHANGED FILES:\n${hot}`);
    }

    if (snapshot.apiEndpoints.length > 0) {
      const apis = snapshot.apiEndpoints
        .slice(0, 10)
        .map((e) => `  - ${e.method} ${e.path} → ${e.sourceFile}`)
        .join('\n');
      sections.push(`API SURFACE:\n${apis}`);
    }

    if (snapshot.decisions.length > 0) {
      const decisions = snapshot.decisions
        .slice(0, 5)
        .map((d) => `  - ${d.title}: ${d.description.substring(0, 120)}`)
        .join('\n');
      sections.push(`ARCHITECTURE DECISIONS:\n${decisions}`);
    }

    return sections.length > 0 ? sections.join('\n\n') : null;
  }

  /* ── Post-Run Update ── */

  /**
   * Update the knowledge graph after a run completes.
   * Call this with the list of changed files and gate results.
   */
  updateAfterRun(params: {
    projectName: string;
    runId: string;
    changedFiles: Array<{ path: string; taskId?: string; gatePassed: boolean }>;
  }): void {
    for (const file of params.changedFiles) {
      // Record file change
      this.recordFileChange({
        projectName: params.projectName,
        filePath: file.path,
        runId: params.runId,
        taskId: file.taskId,
        gatePassed: file.gatePassed,
      });

      // Derive module path (first two path segments)
      const segments = file.path.split('/');
      const modulePath = segments.length >= 2 ? segments.slice(0, 2).join('/') : segments[0];

      // Ensure module exists and update frequency
      const existing = this.getModule(params.projectName, modulePath);
      if (!existing) {
        this.upsertModule(params.projectName, modulePath, {
          moduleType: inferModuleType(modulePath),
        });
      }
      this.incrementModuleChanges(params.projectName, modulePath, file.gatePassed);
    }
  }

  /**
   * Scan a project's source tree and populate the knowledge graph with module
   * boundaries and dependency relationships. Call on first workspace prep
   * when the graph has 0 modules for the project.
   */
  scanProjectStructure(projectName: string, repoPath: string): number {
    const graph = buildImportGraph(repoPath, ['.']);
    if (graph.size === 0) return 0;

    // Derive modules from file paths (group by first 2 path segments)
    const moduleFiles = new Map<string, string[]>();
    for (const filePath of graph.keys()) {
      const segments = filePath.split('/');
      const modulePath = segments.length >= 2 ? segments.slice(0, 2).join('/') : segments[0];
      if (!moduleFiles.has(modulePath)) moduleFiles.set(modulePath, []);
      moduleFiles.get(modulePath)!.push(filePath);
    }

    // Build dependency relationships between modules
    for (const [modulePath, files] of moduleFiles) {
      const deps = new Set<string>();
      const dependents = new Set<string>();

      for (const file of files) {
        const fileDeps = graph.get(file);
        if (!fileDeps) continue;
        for (const dep of fileDeps) {
          const depSegments = dep.split('/');
          const depModule = depSegments.length >= 2 ? depSegments.slice(0, 2).join('/') : depSegments[0];
          if (depModule !== modulePath) deps.add(depModule);
        }
      }

      // Collect dependents by scanning all files that import files in this module
      for (const [otherFile, otherDeps] of graph) {
        const otherSegments = otherFile.split('/');
        const otherModule = otherSegments.length >= 2 ? otherSegments.slice(0, 2).join('/') : otherSegments[0];
        if (otherModule === modulePath) continue;

        for (const dep of otherDeps) {
          if (files.includes(dep)) {
            dependents.add(otherModule);
            break;
          }
        }
      }

      // Collect exports (scan for export statements in module files)
      const exports: string[] = [];
      const exportPattern = /export\s+(?:default\s+)?(?:function|class|const|let|var|interface|type|enum)\s+(\w+)/g;
      for (const file of files.slice(0, 10)) {
        try {
          const content = fs.readFileSync(path.join(repoPath, file), 'utf8');
          let match;
          while ((match = exportPattern.exec(content)) !== null) {
            if (exports.length < 20) exports.push(match[1]);
          }
        } catch {
          // Skip unreadable files
        }
      }

      this.upsertModule(projectName, modulePath, {
        moduleType: inferModuleType(modulePath),
        dependencies: Array.from(deps),
        dependents: Array.from(dependents),
        exports: exports.slice(0, 20),
      });
    }

    return moduleFiles.size;
  }

  close(): void {
    this.db.close();
  }
}

/* ── Helpers ── */

function parseJsonSafe<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapModuleRow(row: Record<string, unknown>): ModuleNode {
  const changeFrequency = Number(row.change_frequency) || 0;
  const failureFrequency = Number(row.failure_frequency) || 0;

  return {
    id: String(row.id),
    projectName: String(row.project_name),
    modulePath: String(row.module_path),
    moduleType: String(row.module_type) as ModuleNode['moduleType'],
    exports: parseJsonSafe<string[]>(row.exports, []),
    dependencies: parseJsonSafe<string[]>(row.dependencies, []),
    dependents: parseJsonSafe<string[]>(row.dependents, []),
    changeFrequency,
    failureFrequency,
    fragilityScore: changeFrequency > 0 ? failureFrequency / changeFrequency : 0,
    notes: parseJsonSafe<string[]>(row.notes, []),
    updatedAt: String(row.updated_at),
  };
}

function inferModuleType(modulePath: string): ModuleNode['moduleType'] {
  const lower = modulePath.toLowerCase();
  if (lower.includes('test') || lower.includes('spec') || lower.includes('__tests__')) return 'test';
  if (lower.includes('component') || lower.includes('ui')) return 'component';
  if (lower.includes('service') || lower.includes('api')) return 'service';
  if (lower.includes('route') || lower.includes('app/')) return 'route';
  if (lower.includes('config') || lower.includes('.env')) return 'config';
  if (lower.includes('domain') || lower.includes('model') || lower.includes('schema')) return 'domain';
  if (lower.includes('infra') || lower.includes('deploy') || lower.includes('docker')) return 'infra';
  return 'util';
}

/* ── Singleton ── */

let instance: KnowledgeGraphStore | null = null;

export function getKnowledgeGraph(): KnowledgeGraphStore {
  if (!instance) {
    instance = new KnowledgeGraphStore();
  }
  return instance;
}
