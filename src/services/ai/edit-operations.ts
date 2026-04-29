import fs from 'fs';
import path from 'path';
import type { FileEdit } from './types.js';

/* ────────────────────────────────────────────────────────────
   JSON extraction & repair (unchanged)
   ──────────────────────────────────────────────────────────── */

export function extractJsonObject(raw: string): string {
  const text = (raw || '')
    .trim()
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim()
    .replace(/[\u00A0\u2028\u2029\u200B]/g, ' ');

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace >= firstBrace) {
    return text.slice(firstBrace, lastBrace + 1);
  }

  throw new Error('No JSON object found.');
}

export function repairJsonObject(raw: string): string {
  return raw
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/}\s*([\r\n]+)\s*{/g, '},$1{')
    .replace(/]\s*([\r\n]+)\s*\[/g, '],$1[')
    .replace(/"\s*([\r\n]+)\s*"/g, '",$1"')
    .trim();
}

export function parseJsonObject<T>(raw: string): T {
  const extracted = extractJsonObject(raw);

  try {
    return JSON.parse(extracted) as T;
  } catch (originalError: any) {
    const repaired = repairJsonObject(extracted);

    try {
      return JSON.parse(repaired) as T;
    } catch (repairError: any) {
      throw new Error(
        `Failed to parse model JSON. Original error: ${originalError?.message || String(originalError)}. Repaired error: ${repairError?.message || String(repairError)}.`,
      );
    }
  }
}

/* ────────────────────────────────────────────────────────────
   Path safety
   ──────────────────────────────────────────────────────────── */

function resolveSafeFilePath(repoPath: string, relativeFilePath: string): string {
  const repoRoot = path.resolve(repoPath);
  const fullPath = path.resolve(repoRoot, relativeFilePath);

  if (fullPath !== repoRoot && !fullPath.startsWith(`${repoRoot}${path.sep}`)) {
    throw new Error(`Blocked unsafe path: ${relativeFilePath}`);
  }

  return fullPath;
}

/* ────────────────────────────────────────────────────────────
   Fuzzy matching
   ──────────────────────────────────────────────────────────── */

function normalizeWhitespace(text: string): string {
  return text.replace(/[ \t]+/g, ' ').replace(/\r\n/g, '\n');
}

/**
 * Compute a similarity ratio between two strings (0-1).
 * Uses normalized Levenshtein for short strings, line-based matching for longer ones.
 */
function similarityRatio(a: string, b: string): number {
  const normA = normalizeWhitespace(a);
  const normB = normalizeWhitespace(b);

  if (normA === normB) return 1;

  // For line-based comparison (more efficient for code blocks)
  const linesA = normA.split('\n').map((l) => l.trim()).filter(Boolean);
  const linesB = normB.split('\n').map((l) => l.trim()).filter(Boolean);

  if (linesA.length === 0 || linesB.length === 0) return 0;

  let matchingLines = 0;
  for (const line of linesA) {
    if (linesB.includes(line)) matchingLines++;
  }

  return matchingLines / Math.max(linesA.length, linesB.length);
}

/**
 * Try to find a fuzzy match for the search block within the file content.
 * Returns the exact substring from the file that best matches, or null.
 */
function findFuzzyMatch(content: string, search: string, threshold = 0.85): string | null {
  const searchLines = search.split('\n');
  const contentLines = content.split('\n');
  const searchLineCount = searchLines.length;

  if (searchLineCount === 0 || contentLines.length === 0) return null;

  let bestMatch: string | null = null;
  let bestScore = threshold;

  // Slide a window of searchLineCount lines across the content
  for (let i = 0; i <= contentLines.length - searchLineCount; i++) {
    const window = contentLines.slice(i, i + searchLineCount).join('\n');
    const score = similarityRatio(search, window);

    if (score > bestScore) {
      bestScore = score;
      bestMatch = window;
    }

    // Also try +/- 1 line window sizes for slight misalignment
    if (i + searchLineCount + 1 <= contentLines.length) {
      const widerWindow = contentLines.slice(i, i + searchLineCount + 1).join('\n');
      const widerScore = similarityRatio(search, widerWindow);
      if (widerScore > bestScore) {
        bestScore = widerScore;
        bestMatch = widerWindow;
      }
    }

    if (searchLineCount > 1 && i + searchLineCount - 1 <= contentLines.length) {
      const narrowerWindow = contentLines.slice(i, i + searchLineCount - 1).join('\n');
      const narrowerScore = similarityRatio(search, narrowerWindow);
      if (narrowerScore > bestScore) {
        bestScore = narrowerScore;
        bestMatch = narrowerWindow;
      }
    }
  }

  return bestMatch;
}

/* ────────────────────────────────────────────────────────────
   Exact match count
   ──────────────────────────────────────────────────────────── */

function countOccurrences(content: string, search: string): number {
  if (!search) return 0;

  let count = 0;
  let searchStartIndex = 0;

  while (true) {
    const foundIndex = content.indexOf(search, searchStartIndex);
    if (foundIndex === -1) break;

    count += 1;
    searchStartIndex = foundIndex + search.length;
  }

  return count;
}

/* ────────────────────────────────────────────────────────────
   Atomic edit application with rollback
   ──────────────────────────────────────────────────────────── */

interface FileSnapshot {
  fullPath: string;
  existed: boolean;
  content: string | null;
}

function snapshotFile(fullPath: string): FileSnapshot {
  const existed = fs.existsSync(fullPath);
  return {
    fullPath,
    existed,
    content: existed ? fs.readFileSync(fullPath, 'utf8') : null,
  };
}

function restoreSnapshot(snapshot: FileSnapshot): void {
  if (snapshot.existed && snapshot.content !== null) {
    fs.writeFileSync(snapshot.fullPath, snapshot.content, 'utf8');
  } else if (!snapshot.existed && fs.existsSync(snapshot.fullPath)) {
    fs.unlinkSync(snapshot.fullPath);
  }
}

export function applyEditsToFiles(repoPath: string, edits: FileEdit[]): string[] {
  const patchErrors: string[] = [];
  const snapshots: FileSnapshot[] = [];
  const appliedPaths: string[] = [];

  for (const edit of edits) {
    if (!edit.filepath) continue;

    if (
      typeof edit.search === 'string' &&
      typeof edit.replace === 'string' &&
      edit.search.length > 0 &&
      edit.search === edit.replace
    ) {
      patchErrors.push(
        `⚠️ Error in ${edit.filepath}: No-op edit (search === replace). If the file is already correct, return "edits": [] instead.`,
      );
      break;
    }

    const fullPath = resolveSafeFilePath(repoPath, edit.filepath);
    const dir = path.dirname(fullPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Snapshot before any modification
    snapshots.push(snapshotFile(fullPath));

    // ── Line-range edit mode ──
    if ('startLine' in edit && typeof (edit as any).startLine === 'number') {
      const lineEdit = edit as any;

      if (!fs.existsSync(fullPath)) {
        patchErrors.push(`⚠️ Error in ${edit.filepath}: File does not exist for line-range edit.`);
        break;
      }

      const content = fs.readFileSync(fullPath, 'utf8');
      const lines = content.split('\n');
      const startLine = Math.max(1, lineEdit.startLine) - 1;
      const endLine = Math.min(lines.length, lineEdit.endLine || lineEdit.startLine);

      lines.splice(startLine, endLine - startLine, edit.replace);
      fs.writeFileSync(fullPath, lines.join('\n'), 'utf8');
      appliedPaths.push(fullPath);
      continue;
    }

    // ── New file / full replacement ──
    if (!fs.existsSync(fullPath) || edit.search.trim() === '') {
      fs.writeFileSync(fullPath, edit.replace, 'utf8');
      appliedPaths.push(fullPath);
      continue;
    }

    // ── Search/replace mode ──
    const content = fs.readFileSync(fullPath, 'utf8');
    const occurrences = countOccurrences(content, edit.search);

    if (occurrences === 1) {
      // Perfect exact match
      fs.writeFileSync(fullPath, content.replace(edit.search, edit.replace), 'utf8');
      appliedPaths.push(fullPath);
      continue;
    }

    if (occurrences > 1) {
      patchErrors.push(
        `⚠️ Error in ${edit.filepath}: Ambiguous 'search' block. Found ${occurrences} matches. Provide a more specific block.`,
      );
      break;
    }

    // occurrences === 0 → try fuzzy matching
    const fuzzyMatch = findFuzzyMatch(content, edit.search);

    if (fuzzyMatch) {
      // Verify the fuzzy match is unique
      const fuzzyOccurrences = countOccurrences(content, fuzzyMatch);

      if (fuzzyOccurrences === 1) {
        console.log(`🔧 Fuzzy match applied for ${edit.filepath} (exact match failed, using closest match)`);
        fs.writeFileSync(fullPath, content.replace(fuzzyMatch, edit.replace), 'utf8');
        appliedPaths.push(fullPath);
        continue;
      }
    }

    // Include current file content snippet so the agent can see what's actually there
    const contentPreview = content.length > 1500
      ? content.substring(0, 1500) + '\n... (truncated)'
      : content;
    patchErrors.push(
      `⚠️ Error in ${edit.filepath}: Exact 'search' block not found (fuzzy match also failed). The file exists but its content does not match your search block.\n\nCURRENT FILE CONTENT:\n\`\`\`\n${contentPreview}\n\`\`\`\n\nRewrite your 'search' block to match the ACTUAL content above.`,
    );
    break;
  }

  // ── Rollback on errors ──
  if (patchErrors.length > 0) {
    for (const snapshot of snapshots) {
      restoreSnapshot(snapshot);
    }
  }

  return patchErrors;
}

/* ────────────────────────────────────────────────────────────
   Helpers
   ──────────────────────────────────────────────────────────── */

export function getDirsToCheck(edits: FileEdit[]): string[] {
  if (!edits.length) return ['.'];

  return Array.from(
    new Set(
      edits.map((edit) => {
        const parts = edit.filepath.split('/');
        return parts.length > 1 ? parts[0] : '.';
      }),
    ),
  );
}
