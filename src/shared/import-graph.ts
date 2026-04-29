/**
 * Shared import graph utilities — used by both the gate system (cycle detection)
 * and the knowledge graph (module dependency tracking).
 */

import fs from 'fs';
import path from 'path';

export type ImportGraph = Map<string, Set<string>>;

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];

function walkDir(dir: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...walkDir(fullPath));
      } else if (SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        files.push(fullPath);
      }
    }
  } catch {
    // Permission or read errors — skip
  }
  return files;
}

export function resolveImportPath(fromFile: string, specifier: string): string | null {
  const dir = path.dirname(fromFile);
  const base = path.resolve(dir, specifier);

  for (const ext of ['', ...SOURCE_EXTENSIONS]) {
    const candidate = base + ext;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  for (const ext of SOURCE_EXTENSIONS) {
    const candidate = path.join(base, `index${ext}`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function buildImportGraph(repoPath: string, scopes: string[]): ImportGraph {
  const graph: ImportGraph = new Map();
  const normalizedScopes = scopes.length ? scopes.map((s) => s.trim()).filter(Boolean) : ['.'];

  const scopeDirs = normalizedScopes.includes('.')
    ? [repoPath]
    : normalizedScopes.map((s) => path.join(repoPath, s));

  const allFiles: string[] = [];
  for (const dir of scopeDirs) {
    allFiles.push(...walkDir(dir));
  }

  const importPattern = /(?:import|export)\s+.*?from\s+['"]([^'"]+)['"]/g;
  const requirePattern = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

  for (const file of allFiles) {
    const relFile = path.relative(repoPath, file);
    const deps = new Set<string>();

    try {
      const content = fs.readFileSync(file, 'utf8');
      for (const pattern of [importPattern, requirePattern]) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(content)) !== null) {
          const specifier = match[1];
          if (!specifier.startsWith('.')) continue;

          const resolved = resolveImportPath(file, specifier);
          if (resolved) {
            deps.add(path.relative(repoPath, resolved));
          }
        }
      }
    } catch {
      // Unreadable file
    }

    graph.set(relFile, deps);
  }

  return graph;
}
