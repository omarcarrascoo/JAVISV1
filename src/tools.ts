import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';

const execPromise = util.promisify(exec);

const IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.expo',
  'ios',
  'android',
  '.next',
]);

const SOURCE_FILE_REGEX = /\.(ts|tsx|js|jsx|json|md|css|scss|html|yaml|yml|graphql|gql|prisma|sql)$/i;
const SAFE_NPM_RUN_SCRIPTS = new Set(['lint', 'test', 'typecheck', 'build', 'start']);
const SAFE_EXPO_COMMAND_PATTERNS = [
  /^npx\s+expo\s+--version$/,
  /^npx\s+expo\s+lint(?:\s+.*)?$/,
  /^npx\s+expo\s+start(?:\s+.*)?$/,
  /^npx\s+expo\s+doctor(?:\s+.*)?$/,
];
const MAX_COMMAND_OUTPUT_CHARS = 12000;
const MAX_COMMAND_OUTPUT_LINES = 300;

/* ────────────────────────────────────────────────────────────
   Public interface
   ──────────────────────────────────────────────────────────── */

export interface AgentToolRuntime {
  tools: typeof agentTools;
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
}

/* ────────────────────────────────────────────────────────────
   Path safety
   ──────────────────────────────────────────────────────────── */

function resolveRepoRoot(repoPath: string): string {
  return path.resolve(repoPath);
}

function resolveSafePath(repoRoot: string, relativePath: string): string {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error('Invalid path: expected non-empty relative path string.');
  }

  const fullPath = path.resolve(repoRoot, relativePath);

  if (fullPath !== repoRoot && !fullPath.startsWith(`${repoRoot}${path.sep}`)) {
    throw new Error(`Path is outside repo root: ${relativePath}`);
  }

  return fullPath;
}

/* ────────────────────────────────────────────────────────────
   Tool: read_file
   ──────────────────────────────────────────────────────────── */

function lineSlice(content: string, startLine = 1, endLine = 500): string {
  const lines = content.split('\n');
  const safeStart = Math.max(1, Math.floor(startLine));
  const safeEnd = Math.max(safeStart, Math.floor(endLine));
  const clippedEnd = Math.min(lines.length, safeEnd);

  return lines
    .slice(safeStart - 1, clippedEnd)
    .map((line, index) => {
      const lineNumber = String(safeStart + index).padStart(4, ' ');
      return `${lineNumber}| ${line}`;
    })
    .join('\n');
}

function readFile(repoRoot: string, filepath: string, startLine = 1, endLine = 500): string {
  try {
    const fullPath = resolveSafePath(repoRoot, filepath);

    if (!fs.existsSync(fullPath)) return `Error: file "${filepath}" does not exist.`;
    if (!fs.statSync(fullPath).isFile()) return `Error: path "${filepath}" is not a file.`;

    const content = fs.readFileSync(fullPath, 'utf8');
    const totalLines = content.split('\n').length;
    const relative = path.relative(repoRoot, fullPath);

    return `FILE: ${relative} (${totalLines} lines)\nSHOWING: ${startLine}-${Math.min(endLine, totalLines)}\n\n${lineSlice(content, startLine, endLine)}`;
  } catch (error: any) {
    return `Error reading file "${filepath}": ${error.message}`;
  }
}

/* ────────────────────────────────────────────────────────────
   Tool: grep_code  (NEW — regex search with context)
   ──────────────────────────────────────────────────────────── */

interface GrepMatch {
  file: string;
  lines: Array<{ line: number; text: string }>;
}

function grepCode(
  repoRoot: string,
  pattern: string,
  options: { fileGlob?: string; maxResults?: number; contextLines?: number } = {},
): string {
  const maxResults = Math.min(options.maxResults || 30, 100);
  const contextLines = Math.min(options.contextLines || 0, 5);
  const hits: GrepMatch[] = [];

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, 'i');
  } catch {
    return `Error: invalid regex pattern "${pattern}".`;
  }

  const fileGlobRegex = options.fileGlob ? globToRegex(options.fileGlob) : null;

  function walk(dir: string): void {
    if (hits.length >= maxResults) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (hits.length >= maxResults) break;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) walk(fullPath);
        continue;
      }

      if (!SOURCE_FILE_REGEX.test(entry.name)) continue;

      const relativePath = path.relative(repoRoot, fullPath);
      if (fileGlobRegex && !fileGlobRegex.test(relativePath)) continue;

      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        const lines = content.split('\n');
        const matchingLineNumbers: number[] = [];

        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            matchingLineNumbers.push(i);
            if (matchingLineNumbers.length >= 10) break;
          }
        }

        if (matchingLineNumbers.length === 0) continue;

        const resultLines: Array<{ line: number; text: string }> = [];
        const shownLines = new Set<number>();

        for (const lineIdx of matchingLineNumbers) {
          const start = Math.max(0, lineIdx - contextLines);
          const end = Math.min(lines.length - 1, lineIdx + contextLines);

          for (let j = start; j <= end; j++) {
            if (!shownLines.has(j)) {
              shownLines.add(j);
              resultLines.push({ line: j + 1, text: lines[j] });
            }
          }
        }

        resultLines.sort((a, b) => a.line - b.line);

        hits.push({ file: relativePath, lines: resultLines });
      } catch {
        // Skip unreadable files
      }
    }
  }

  walk(repoRoot);

  if (!hits.length) return `No matches found for pattern /${pattern}/i.`;

  const output = hits
    .map((hit) => {
      const snippets = hit.lines
        .map((l) => `  ${String(l.line).padStart(4, ' ')}| ${l.text}`)
        .join('\n');
      return `- ${hit.file} (${hit.lines.length} lines)\n${snippets}`;
    })
    .join('\n\n');

  return `Pattern /${pattern}/i matched in ${hits.length} file(s):\n\n${output}`;
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '<<GLOBSTAR>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<GLOBSTAR>>/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

/* ────────────────────────────────────────────────────────────
   Tool: list_directory  (NEW — recursive listing)
   ──────────────────────────────────────────────────────────── */

function listDirectory(
  repoRoot: string,
  dirPath: string,
  options: { depth?: number; fileGlob?: string } = {},
): string {
  const maxDepth = Math.min(options.depth || 3, 6);
  const fileGlobRegex = options.fileGlob ? globToRegex(options.fileGlob) : null;
  const output: string[] = [];

  function walk(dir: string, prefix: string, currentDepth: number): void {
    if (currentDepth > maxDepth) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const dirs = entries.filter((e) => e.isDirectory() && !IGNORE_DIRS.has(e.name)).sort((a, b) => a.name.localeCompare(b.name));
    const files = entries.filter((e) => e.isFile()).sort((a, b) => a.name.localeCompare(b.name));

    const all = [...dirs, ...files];

    for (let i = 0; i < all.length; i++) {
      const entry = all[i];
      const isLast = i === all.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(repoRoot, fullPath);

      if (entry.isDirectory()) {
        output.push(`${prefix}${connector}${entry.name}/`);
        walk(fullPath, prefix + (isLast ? '    ' : '│   '), currentDepth + 1);
      } else {
        if (fileGlobRegex && !fileGlobRegex.test(relativePath)) continue;

        try {
          const stat = fs.statSync(fullPath);
          const sizeKb = (stat.size / 1024).toFixed(1);
          output.push(`${prefix}${connector}${entry.name} (${sizeKb}KB)`);
        } catch {
          output.push(`${prefix}${connector}${entry.name}`);
        }
      }
    }
  }

  const targetDir = resolveSafePath(repoRoot, dirPath || '.');

  if (!fs.existsSync(targetDir)) {
    return `Error: directory "${dirPath}" does not exist.`;
  }

  output.push(`${path.relative(repoRoot, targetDir) || '.'}/`);
  walk(targetDir, '', 1);

  if (output.length > 500) {
    return output.slice(0, 500).join('\n') + '\n... [truncated, use depth or fileGlob to narrow]';
  }

  return output.join('\n');
}

/* ────────────────────────────────────────────────────────────
   Tool: find_references  (NEW — import/usage tracking)
   ──────────────────────────────────────────────────────────── */

interface ReferenceHit {
  file: string;
  line: number;
  text: string;
  kind: 'import' | 'usage';
}

function findReferences(
  repoRoot: string,
  symbol: string,
  options: { maxResults?: number } = {},
): string {
  const maxResults = Math.min(options.maxResults || 50, 100);
  const hits: ReferenceHit[] = [];

  const importPatterns = [
    new RegExp(`import\\s+.*\\b${escapeRegex(symbol)}\\b.*from\\s+`, 'i'),
    new RegExp(`import\\s*\\{[^}]*\\b${escapeRegex(symbol)}\\b[^}]*\\}`, 'i'),
    new RegExp(`require\\s*\\([^)]*${escapeRegex(symbol)}`, 'i'),
  ];
  const usagePattern = new RegExp(`\\b${escapeRegex(symbol)}\\b`);

  function walk(dir: string): void {
    if (hits.length >= maxResults) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (hits.length >= maxResults) break;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) walk(fullPath);
        continue;
      }

      if (!/\.(ts|tsx|js|jsx)$/i.test(entry.name)) continue;

      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        if (!usagePattern.test(content)) continue;

        const lines = content.split('\n');
        const relativePath = path.relative(repoRoot, fullPath);

        for (let i = 0; i < lines.length; i++) {
          if (hits.length >= maxResults) break;

          const line = lines[i];
          if (!usagePattern.test(line)) continue;

          const isImport = importPatterns.some((p) => p.test(line));

          hits.push({
            file: relativePath,
            line: i + 1,
            text: line.trim(),
            kind: isImport ? 'import' : 'usage',
          });
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  walk(repoRoot);

  if (!hits.length) return `No references found for symbol "${symbol}".`;

  const imports = hits.filter((h) => h.kind === 'import');
  const usages = hits.filter((h) => h.kind === 'usage');

  let output = `Found ${hits.length} reference(s) for "${symbol}" (${imports.length} imports, ${usages.length} usages):\n\n`;

  if (imports.length > 0) {
    output += 'IMPORTS:\n';
    output += imports
      .map((h) => `  ${h.file}:${h.line} → ${h.text}`)
      .join('\n');
    output += '\n\n';
  }

  if (usages.length > 0) {
    output += 'USAGES:\n';
    output += usages
      .map((h) => `  ${h.file}:${h.line} → ${h.text}`)
      .join('\n');
  }

  return output;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ────────────────────────────────────────────────────────────
   Tool: search_project  (kept for backward compat, improved)
   ──────────────────────────────────────────────────────────── */

interface SearchHit {
  file: string;
  lines: Array<{ line: number; text: string }>;
}

function collectSearchHits(
  repoRoot: string,
  keyword: string,
  maxResults: number,
  dir = repoRoot,
  hits: SearchHit[] = [],
): SearchHit[] {
  if (hits.length >= maxResults) return hits;

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (hits.length >= maxResults) break;

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) {
        collectSearchHits(repoRoot, keyword, maxResults, fullPath, hits);
      }
      continue;
    }

    if (!SOURCE_FILE_REGEX.test(entry.name)) continue;

    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      if (!content.toLowerCase().includes(keyword.toLowerCase())) continue;

      const matches: Array<{ line: number; text: string }> = [];
      const lines = content.split('\n');

      for (let index = 0; index < lines.length; index++) {
        if (lines[index].toLowerCase().includes(keyword.toLowerCase())) {
          matches.push({ line: index + 1, text: lines[index].trim() });
          if (matches.length >= 5) break;
        }
      }

      hits.push({
        file: path.relative(repoRoot, fullPath),
        lines: matches,
      });
    } catch {
      // Ignore unreadable files
    }
  }

  return hits;
}

function searchProject(repoRoot: string, keyword: string, maxResults = 30): string {
  try {
    if (typeof keyword !== 'string' || !keyword.trim()) {
      return 'Error: keyword must be a non-empty string.';
    }

    const safeLimit = Math.min(100, Math.max(1, Math.floor(maxResults)));
    const hits = collectSearchHits(repoRoot, keyword.trim(), safeLimit);

    if (!hits.length) return `No matches found for "${keyword}".`;

    const output = hits
      .map((hit) => {
        const snippets = hit.lines
          .map((line) => `  ${String(line.line).padStart(4, ' ')}| ${line.text}`)
          .join('\n');
        return `- ${hit.file}\n${snippets}`;
      })
      .join('\n');

    return `Keyword "${keyword}" found in ${hits.length} file(s):\n${output}`;
  } catch (error: any) {
    return `Error during search_project: ${error.message}`;
  }
}

/* ────────────────────────────────────────────────────────────
   Tool: run_command  (improved — higher timeout, better output)
   ──────────────────────────────────────────────────────────── */

function isSafeCdCommand(command: string): boolean {
  const match = command.match(/^cd\s+(.+)$/);
  if (!match) return false;

  const target = match[1].trim();

  if (!target || target.includes('..') || target.includes('~')) {
    return false;
  }

  return !path.isAbsolute(target);
}

function isSafeNpmRunCommand(command: string): boolean {
  const match = command.match(/^npm\s+run\s+([a-zA-Z0-9:_-]+)(?:\s+--.*)?$/);
  if (!match) return false;

  return SAFE_NPM_RUN_SCRIPTS.has(match[1]);
}

function isFilterableExecutionCommand(command: string): boolean {
  return [
    /^npm\s+run\s+/,
    /^npx\s+tsc\b/,
    /^npx\s+expo\s+(lint|start|doctor)\b/,
    /^npx\s+expo\s+--version$/,
    /^npx\s+eslint\b/,
    /^npx\s+prettier\b/,
    /^git\s+(status|diff|log)\b/,
  ].some((pattern) => pattern.test(command));
}

function stripQuotedSegments(command: string): string {
  return command
    .replace(/"([^"\\]|\\.)*"/g, '""')
    .replace(/'([^'\\]|\\.)*'/g, "''");
}

function isSafeExpoCommand(command: string): boolean {
  return SAFE_EXPO_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

function normalizeInspectionCommand(command: string): string {
  let normalized = command.trim();

  normalized = normalized.replace(/\s+2>\s*\/dev\/null\b/g, '');
  normalized = normalized.replace(/\s+2>&1\b/g, '');

  if (isFilterableExecutionCommand(normalized) && normalized.includes('|')) {
    normalized = normalized.split('|')[0].trim();
  }

  return normalized;
}

function isAllowedReadOnlyCommand(command: string): boolean {
  if (!command) return false;

  const normalized = command.trim();

  if (normalized === 'pwd') return true;
  if (normalized === 'ls' || normalized.startsWith('ls ')) return true;
  if (normalized === 'cat' || normalized.startsWith('cat ')) return true;
  if (normalized === 'head' || normalized.startsWith('head ')) return true;
  if (normalized === 'tail' || normalized.startsWith('tail ')) return true;
  if (normalized === 'sort' || normalized.startsWith('sort ')) return true;
  if (normalized === 'wc' || normalized.startsWith('wc ')) return true;
  if (normalized.startsWith('grep ')) return true;
  if (normalized.startsWith('rg ')) return true;

  if (normalized.startsWith('sed ')) {
    return /\bsed\s+-n\b/.test(normalized) && !/\bsed\s+-i\b/.test(normalized);
  }

  if (normalized.startsWith('find ')) {
    return !/\s-(exec|ok|delete|fprint|fls|print0)\b/.test(normalized);
  }

  if (normalized === 'git status' || normalized.startsWith('git status ')) return true;
  if (normalized === 'git diff' || normalized.startsWith('git diff ')) return true;
  if (normalized === 'git log' || normalized.startsWith('git log ')) return true;

  return false;
}

function isAllowedPipeline(command: string): boolean {
  const segments = command
    .split('|')
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length <= 1) {
    return false;
  }

  return segments.every((segment) => isAllowedReadOnlyCommand(segment));
}

function isAllowedSubCommand(command: string): boolean {
  if (!command) return false;

  const normalized = normalizeInspectionCommand(command);

  if (normalized.startsWith('npm install')) return true;
  if (normalized.startsWith('npm uninstall')) return true;
  if (normalized === 'npm i' || normalized.startsWith('npm i ')) return true;
  if (isSafeExpoCommand(normalized)) return true;
  if (normalized.startsWith('npx tsc')) return true;
  if (normalized.startsWith('npx eslint')) return true;
  if (normalized.startsWith('npx prettier')) return true;
  if (normalized.startsWith('npx jest') || normalized.startsWith('npx vitest')) return true;

  if (isAllowedReadOnlyCommand(normalized)) return true;
  if (isAllowedPipeline(normalized)) return true;

  if (isSafeCdCommand(normalized)) return true;
  if (isSafeNpmRunCommand(normalized)) return true;

  return false;
}

function truncateCommandOutput(output: string): string {
  const clippedByChars =
    output.length > MAX_COMMAND_OUTPUT_CHARS
      ? `${output.slice(0, MAX_COMMAND_OUTPUT_CHARS)}\n... [truncated]`
      : output;

  const lines = clippedByChars.split('\n');
  if (lines.length <= MAX_COMMAND_OUTPUT_LINES) {
    return clippedByChars;
  }

  return `${lines.slice(0, MAX_COMMAND_OUTPUT_LINES).join('\n')}\n... [truncated]`;
}

async function runCommand(repoRoot: string, cmd: string): Promise<string> {
  const trimmedCmd = cmd.trim();

  if (!trimmedCmd) {
    return '🚨 SECURITY EXCEPTION: Command rejected. Empty command.';
  }

  const blockedPatterns = [
    /\.\.\//,
    /(^|\s)\.\.(\/|\s|$)/,
    /(^|\s)\/(?!dev|tmp)/,
    /~/,
    /;/,
    /\|\|/,
    />/,
    /</,
    /(^|[^&])&([^&]|$)/,
    /`/,
    /\$\(/,
  ];

  const sanitizedCmd = trimmedCmd
    .replace(/\s+2>\s*\/dev\/null\b/g, '')
    .replace(/\s+2>&1\b/g, '')
    .trim();
  const analyzedCmd = stripQuotedSegments(sanitizedCmd);

  for (const pattern of blockedPatterns) {
    if (pattern.test(analyzedCmd)) {
      console.log(`🚨 SECURITY BLOCK: Unsafe shell pattern in command: ${trimmedCmd}`);
      return '🚨 SECURITY EXCEPTION: Command rejected. Unsafe shell operators are not allowed. Use read-only inspection commands like ls/find/grep/cat/sed -n or validation commands without redirection.';
    }
  }

  const subCommands = sanitizedCmd
    .split('&&')
    .map((segment) => normalizeInspectionCommand(segment))
    .filter(Boolean);

  if (subCommands.length === 0) {
    return '🚨 SECURITY EXCEPTION: Command rejected. No valid subcommands found.';
  }

  for (const subCommand of subCommands) {
    if (!isAllowedSubCommand(subCommand)) {
      console.log(`🚨 SECURITY BLOCK: Unauthorized command attempted: ${subCommand}`);
      return '🚨 SECURITY EXCEPTION: Command rejected. Only safe development commands are allowed.';
    }
  }

  try {
    const normalizedCmd = subCommands.join(' && ');
    console.log(`💻 Executing safe command in ${repoRoot}: ${normalizedCmd}`);
    const { stdout, stderr } = await execPromise(normalizedCmd, {
      cwd: repoRoot,
      timeout: 30000,
    });

    let output = '';
    if (stdout) output += `STDOUT:\n${stdout}\n`;
    if (stderr) output += `STDERR:\n${stderr}\n`;

    const finalOutput = output.trim() ? output.trim() : 'Command executed successfully with no output.';
    return truncateCommandOutput(finalOutput);
  } catch (error: any) {
    return truncateCommandOutput(
      `⚠️ Command failed:\nSTDOUT:\n${error.stdout}\nSTDERR:\n${error.stderr}\nMESSAGE:\n${error.message}`,
    );
  }
}

/* ────────────────────────────────────────────────────────────
   Tool: run_tests  (NEW — targeted test execution)
   ──────────────────────────────────────────────────────────── */

async function runTests(
  repoRoot: string,
  testPath?: string,
  options: { timeout?: number } = {},
): Promise<string> {
  const timeout = Math.min(options.timeout || 60000, 120000);

  let cmd: string;
  if (testPath) {
    // Run specific test file or pattern
    const safePath = resolveSafePath(repoRoot, testPath);
    const relative = path.relative(repoRoot, safePath);

    // Detect test runner from package.json
    const pkgPath = path.join(repoRoot, 'package.json');
    let runner = 'npx jest';

    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const devDeps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (devDeps.vitest) runner = 'npx vitest run';
        else if (devDeps.jest) runner = 'npx jest';
      } catch {
        // Default to jest
      }
    }

    cmd = `${runner} ${relative} --no-coverage`;
  } else {
    cmd = 'npm run test -- --no-coverage';
  }

  try {
    console.log(`🧪 Running tests: ${cmd}`);
    const { stdout, stderr } = await execPromise(cmd, {
      cwd: repoRoot,
      timeout,
      env: { ...process.env, CI: 'true', NODE_ENV: 'test' },
    });

    let output = '';
    if (stdout) output += stdout;
    if (stderr) output += `\n${stderr}`;

    return truncateCommandOutput(`TEST RESULTS:\n${output.trim()}`);
  } catch (error: any) {
    const output = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n');
    return truncateCommandOutput(`TEST FAILURE:\n${output}`);
  }
}

/* ────────────────────────────────────────────────────────────
   Tool: write_file  (NEW — mid-loop file creation/replacement)
   ──────────────────────────────────────────────────────────── */

function writeFile(repoRoot: string, filepath: string, content: string): string {
  try {
    const fullPath = resolveSafePath(repoRoot, filepath);
    const dir = path.dirname(fullPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const existed = fs.existsSync(fullPath);
    fs.writeFileSync(fullPath, content, 'utf8');

    const lineCount = content.split('\n').length;
    return `${existed ? 'Updated' : 'Created'} ${filepath} (${lineCount} lines)`;
  } catch (error: any) {
    return `Error writing file "${filepath}": ${error.message}`;
  }
}

/* ────────────────────────────────────────────────────────────
   Tool dispatcher + definitions
   ──────────────────────────────────────────────────────────── */

export function createAgentToolRuntime(repoPath: string): AgentToolRuntime {
  const repoRoot = resolveRepoRoot(repoPath);

  return {
    tools: agentTools,
    executeTool: async (name: string, args: Record<string, unknown>): Promise<string> => {
      switch (name) {
        case 'read_file':
          return readFile(
            repoRoot,
            args.filepath as string,
            args.startLine as number | undefined,
            args.endLine as number | undefined,
          );

        case 'grep_code':
          return grepCode(repoRoot, args.pattern as string, {
            fileGlob: args.fileGlob as string | undefined,
            maxResults: args.maxResults as number | undefined,
            contextLines: args.contextLines as number | undefined,
          });

        case 'search_project':
          return searchProject(
            repoRoot,
            args.keyword as string,
            args.maxResults as number | undefined,
          );

        case 'list_directory':
          return listDirectory(repoRoot, (args.path as string) || '.', {
            depth: args.depth as number | undefined,
            fileGlob: args.fileGlob as string | undefined,
          });

        case 'find_references':
          return findReferences(repoRoot, args.symbol as string, {
            maxResults: args.maxResults as number | undefined,
          });

        case 'run_command':
          return runCommand(repoRoot, args.cmd as string);

        case 'run_tests':
          return runTests(repoRoot, args.testPath as string | undefined, {
            timeout: args.timeout as number | undefined,
          });

        case 'write_file':
          return writeFile(repoRoot, args.filepath as string, args.content as string);

        default:
          return `Tool error: Unsupported tool "${name}"`;
      }
    },
  };
}

export const agentTools = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a project file. Use relative paths from repo root. Supports line range for targeted inspection. Default shows up to 500 lines.',
      parameters: {
        type: 'object',
        properties: {
          filepath: { type: 'string', description: 'Relative path like "src/app/page.tsx".' },
          startLine: { type: 'number', description: 'Optional first line number (1-based).' },
          endLine: { type: 'number', description: 'Optional last line number (1-based, default 500).' },
        },
        required: ['filepath'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep_code',
      description:
        'Search file contents using a regex pattern. Returns matching lines with optional context. More powerful than search_project — supports regex, file filtering, and context lines.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Regex pattern to search for (case-insensitive). Example: "export.*function\\s+handle", "interface.*Props".',
          },
          fileGlob: {
            type: 'string',
            description: 'Optional glob to filter files. Example: "src/**/*.ts", "*.controller.ts".',
          },
          maxResults: { type: 'number', description: 'Max files to return (default 30, max 100).' },
          contextLines: { type: 'number', description: 'Lines of context around each match (default 0, max 5).' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_project',
      description:
        'Search keyword usage across source files. Returns file paths with line snippets. For regex or context lines, use grep_code instead.',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: 'String token like "UserService" or "JwtAuthGuard".' },
          maxResults: { type: 'number', description: 'Optional cap for matching files (default 30, max 100).' },
        },
        required: ['keyword'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description:
        'List files and directories in a tree format with sizes. Useful for understanding project structure beyond the initial tree.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative directory path (default "." for repo root).' },
          depth: { type: 'number', description: 'Max depth to recurse (default 3, max 6).' },
          fileGlob: { type: 'string', description: 'Optional glob to filter files. Example: "*.ts".' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_references',
      description:
        'Find all imports and usages of a symbol (function, class, type, component) across the codebase. Returns categorized results: imports vs. usages with file:line locations.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'The symbol name to find. Example: "UserService", "handleSubmit", "AuthGuard".' },
          maxResults: { type: 'number', description: 'Max references to return (default 50, max 100).' },
        },
        required: ['symbol'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Execute a safe bash command in the repository root. For validation (lint/test/typecheck/build) and read-only inspection (ls, find, grep, rg, cat, git status/diff/log). Output is automatically truncated.',
      parameters: {
        type: 'object',
        properties: {
          cmd: { type: 'string', description: 'The bash command to execute.' },
        },
        required: ['cmd'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_tests',
      description:
        'Run tests for a specific file or the entire test suite. Automatically detects Jest or Vitest. Use this instead of run_command for test execution — it has a longer timeout and proper environment setup.',
      parameters: {
        type: 'object',
        properties: {
          testPath: {
            type: 'string',
            description: 'Optional relative path to a test file or directory. If omitted, runs the full test suite.',
          },
          timeout: { type: 'number', description: 'Timeout in ms (default 60000, max 120000).' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Create or overwrite a file during the exploration/implementation phase. Use this for creating new files or when a complete file rewrite is cleaner than search/replace patches. The file will be included in the final commit.',
      parameters: {
        type: 'object',
        properties: {
          filepath: { type: 'string', description: 'Relative path for the file to create/overwrite.' },
          content: { type: 'string', description: 'The complete file content to write.' },
        },
        required: ['filepath', 'content'],
      },
    },
  },
] as const;
