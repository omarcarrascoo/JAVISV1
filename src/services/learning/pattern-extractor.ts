/**
 * Pattern Extractor — distills successful task executions into reusable patterns.
 *
 * After a task succeeds, this module analyzes the execution trail
 * (tool history, files touched, iterations, scope) and produces
 * a LearnedPattern that can guide future similar tasks.
 */

import { roleCompletion } from '../ai/completion.js';
import { getLearningStore, type LearnedPattern } from './learning-store.js';

export interface TaskExecutionTrace {
  runId: string;
  taskId: string;
  projectName: string;
  taskTitle: string;
  taskKind: string;
  taskPrompt: string;
  writeScope: string[];
  iterations: number;
  tokensUsed: number;
  filesRead: string[];
  filesEdited: string[];
  toolHistory: string[];
  commitMessage: string;
  gateResults: Array<{ name: string; status: string }>;
}

/**
 * Extract keywords from a task prompt for pattern tagging.
 * Uses a simple approach: extract meaningful words, skip stop words.
 */
function extractKeywords(prompt: string, title: string): string[] {
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
    'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
    'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
    'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
    'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'both',
    'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor',
    'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just',
    'and', 'but', 'or', 'if', 'this', 'that', 'these', 'those', 'it',
    'its', 'they', 'them', 'their', 'task', 'file', 'code', 'make',
    'ensure', 'implement', 'create', 'update', 'fix', 'add', 'remove',
    'change', 'modify', 'execution', 'contract', 'instruction',
  ]);

  const combined = `${title} ${prompt}`;
  const words = combined
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));

  // Deduplicate and take top keywords by frequency
  const freq = new Map<string, number>();
  for (const w of words) {
    freq.set(w, (freq.get(w) || 0) + 1);
  }

  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word]) => word);
}

/**
 * Compute the dominant file scope pattern from edited files.
 * e.g., ["src/api/auth/login.ts", "src/api/auth/register.ts"] → "src/api/auth"
 */
function computeFilePattern(filesEdited: string[]): string {
  if (filesEdited.length === 0) return '.';
  if (filesEdited.length === 1) {
    const parts = filesEdited[0].split('/');
    return parts.length > 1 ? parts.slice(0, -1).join('/') : '.';
  }

  // Find longest common prefix
  const parts = filesEdited.map((f) => f.split('/'));
  const minLen = Math.min(...parts.map((p) => p.length));
  const common: string[] = [];

  for (let i = 0; i < minLen - 1; i++) {
    const segment = parts[0][i];
    if (parts.every((p) => p[i] === segment)) {
      common.push(segment);
    } else {
      break;
    }
  }

  return common.length > 0 ? common.join('/') : '.';
}

/**
 * Identify the most-used tools from the tool history.
 */
function computeTopTools(toolHistory: string[]): string[] {
  const freq = new Map<string, number>();
  for (const entry of toolHistory) {
    const toolName = entry.split(':')[0];
    freq.set(toolName, (freq.get(toolName) || 0) + 1);
  }

  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name]) => name);
}

/**
 * Generate a concise natural language approach summary using the LLM.
 * Falls back to a structured template if the LLM call fails.
 */
async function generateApproachSummary(trace: TaskExecutionTrace): Promise<string> {
  const structuredFallback = buildStructuredApproach(trace);

  try {
    const response = await roleCompletion('repair', {
      messages: [
        {
          role: 'user',
          content: `Summarize the approach used in this successful coding task in 2-3 sentences.
Focus on: what files/patterns were key, what strategy worked, and any pitfalls avoided.
Keep it concise and actionable for a future agent facing a similar task.

Task: ${trace.taskTitle}
Kind: ${trace.taskKind}
Files read: ${trace.filesRead.slice(0, 10).join(', ')}
Files edited: ${trace.filesEdited.join(', ')}
Iterations: ${trace.iterations}
Tools used most: ${computeTopTools(trace.toolHistory).join(', ')}
Commit: ${trace.commitMessage}
Write scope: ${trace.writeScope.join(', ')}

Return ONLY the summary text, no JSON.`,
        },
      ],
      maxTokens: 200,
    });

    const summary = response.content?.trim();
    return summary && summary.length > 20 ? summary : structuredFallback;
  } catch {
    return structuredFallback;
  }
}

/**
 * Structured fallback when LLM summarization fails.
 */
function buildStructuredApproach(trace: TaskExecutionTrace): string {
  const topTools = computeTopTools(trace.toolHistory);
  const keyFiles = trace.filesEdited.slice(0, 3).join(', ');
  const readCount = trace.filesRead.length;

  return `${trace.taskKind} task in ${trace.writeScope.join(', ')}. ` +
    `Edited ${trace.filesEdited.length} file(s) [${keyFiles}] after reading ${readCount} file(s). ` +
    `Completed in ${trace.iterations} iteration(s) using primarily ${topTools.join(', ')}.`;
}

/**
 * Extract a learned pattern from a successful task execution.
 * This is the main entry point — call after a task succeeds all gates.
 */
export async function extractPattern(trace: TaskExecutionTrace): Promise<LearnedPattern | null> {
  // Don't learn from trivial tasks (0 edits or 1 iteration = too simple to learn from)
  if (trace.filesEdited.length === 0) return null;
  if (trace.iterations <= 1 && trace.filesEdited.length <= 1) return null;

  const store = getLearningStore();

  // Check for existing similar pattern (same project + kind + scope)
  const filePattern = computeFilePattern(trace.filesEdited);
  const existingMatches = store.findRelevantPatterns({
    projectName: trace.projectName,
    taskKind: trace.taskKind,
    writeScope: trace.writeScope,
    promptKeywords: extractKeywords(trace.taskPrompt, trace.taskTitle),
    limit: 3,
  });

  // If there's already a very similar pattern, don't create a duplicate
  const tooSimilar = existingMatches.some(
    (m) =>
      m.relevanceScore > 0.85 &&
      m.pattern.filePattern === filePattern &&
      m.pattern.taskKind === trace.taskKind,
  );

  if (tooSimilar) {
    console.log(`📚 Skipping pattern extraction — similar pattern already exists for ${filePattern}`);
    return null;
  }

  const approach = await generateApproachSummary(trace);
  const tags = extractKeywords(trace.taskPrompt, trace.taskTitle);
  const topTools = computeTopTools(trace.toolHistory);
  const now = nowIso();

  const patternId = `pat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const pattern: LearnedPattern = {
    id: patternId,
    projectName: trace.projectName,
    taskKind: trace.taskKind,
    filePattern,
    tags,
    approach,
    iterations: trace.iterations,
    tokensUsed: trace.tokensUsed,
    filesRead: trace.filesRead.slice(0, 20),
    filesEdited: trace.filesEdited,
    topTools,
    timesApplied: 0,
    timesSucceeded: 0,
    timesFailed: 0,
    effectivenessScore: 0,
    sourceRunId: trace.runId,
    sourceTaskId: trace.taskId,
    createdAt: now,
    updatedAt: now,
  };

  store.savePattern(pattern);
  console.log(`📚 Learned pattern "${patternId}" from task "${trace.taskTitle}" (${filePattern}, ${tags.slice(0, 5).join(', ')})`);

  return pattern;
}

function nowIso(): string {
  return new Date().toISOString();
}
