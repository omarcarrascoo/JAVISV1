/**
 * Prompt Injector — retrieves relevant learned patterns and formats them
 * as few-shot guidance for the agent's system prompt.
 *
 * This is the bridge between the learning store and the agent runtime.
 * It finds patterns matching the current task context, formats them as
 * actionable advice, and tracks which patterns were applied for
 * effectiveness measurement.
 */

import { getLearningStore, type PatternMatch } from './learning-store.js';

export interface LearningContext {
  /** Formatted prompt section to inject */
  promptSection: string;
  /** Pattern IDs that were injected (for outcome tracking) */
  appliedPatternIds: string[];
}

/**
 * Build learning context for a task.
 * Returns a formatted prompt section + list of applied pattern IDs.
 *
 * Call this before building the agent prompt and inject `promptSection`
 * into the system prompt.
 */
export function buildLearningContext(params: {
  projectName: string;
  taskKind: string;
  taskTitle: string;
  taskPrompt: string;
  writeScope: string[];
}): LearningContext {
  const store = getLearningStore();

  // Extract keywords from the task for matching
  const keywords = extractSimpleKeywords(params.taskTitle, params.taskPrompt);

  const matches = store.findRelevantPatterns({
    projectName: params.projectName,
    taskKind: params.taskKind,
    writeScope: params.writeScope,
    promptKeywords: keywords,
    limit: 3,
  });

  if (matches.length === 0) {
    return { promptSection: '', appliedPatternIds: [] };
  }

  const appliedPatternIds = matches.map((m) => m.pattern.id);
  const promptSection = formatPatternsAsGuidance(matches);

  return { promptSection, appliedPatternIds };
}

/**
 * Format matched patterns as a prompt section.
 * Uses concise, actionable language the agent can follow.
 */
function formatPatternsAsGuidance(matches: PatternMatch[]): string {
  const lines = matches.map((match, i) => {
    const p = match.pattern;
    const effectiveness =
      p.timesApplied >= 2
        ? ` (${Math.round(p.effectivenessScore * 100)}% success rate over ${p.timesApplied} applications)`
        : ' (newly learned)';

    const filesHint =
      p.filesEdited.length > 0
        ? `\n   Key files: ${p.filesEdited.slice(0, 4).join(', ')}`
        : '';

    const toolsHint =
      p.topTools.length > 0
        ? `\n   Effective tools: ${p.topTools.join(', ')}`
        : '';

    return `${i + 1}. [${p.taskKind}] ${p.approach}${effectiveness}${filesHint}${toolsHint}`;
  });

  return `LEARNED PATTERNS (from previous successful runs):
${lines.join('\n')}

Use these patterns as guidance — they reflect approaches that worked before in similar contexts.
Adapt them to the current task rather than following blindly.`;
}

/**
 * Simple keyword extraction for matching (no LLM needed).
 */
function extractSimpleKeywords(title: string, prompt: string): string[] {
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'and',
    'but', 'or', 'if', 'this', 'that', 'these', 'those', 'it', 'its',
    'they', 'them', 'their', 'not', 'only', 'own', 'same', 'so', 'than',
    'too', 'very', 'just', 'task', 'file', 'code', 'make', 'ensure',
    'execution', 'contract', 'instruction', 'produce', 'concrete',
    'changes', 'prioritize', 'requested', 'outcome', 'adjacent', 'cleanup',
    'stay', 'within', 'write', 'scopes', 'unless', 'directly', 'related',
    'strictly', 'required', 'chase', 'unrelated', 'repo', 'errors',
    'outside', 'your', 'scope', 'notice', 'leave', 'untouched', 'focus',
    'making', 'healthy',
  ]);

  // Take first ~300 chars of prompt to avoid noise from the execution contract boilerplate
  const text = `${title} ${prompt.slice(0, 300)}`;
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));

  // Deduplicate
  return [...new Set(words)].slice(0, 15);
}

/**
 * After a task completes (success or failure), record the outcome
 * for each pattern that was applied.
 */
export function recordPatternOutcomes(params: {
  appliedPatternIds: string[];
  taskId: string;
  runId: string;
  succeeded: boolean;
  iterations: number;
  tokensUsed: number;
}): void {
  if (params.appliedPatternIds.length === 0) return;

  const store = getLearningStore();

  for (const patternId of params.appliedPatternIds) {
    store.recordOutcome({
      patternId,
      taskId: params.taskId,
      runId: params.runId,
      succeeded: params.succeeded,
      iterations: params.iterations,
      tokensUsed: params.tokensUsed,
    });
  }

  // Periodically prune ineffective patterns (every ~10 outcome recordings)
  if (Math.random() < 0.1) {
    const pruned = store.pruneIneffectivePatterns();
    if (pruned > 0) {
      console.log(`📚 Pruned ${pruned} ineffective pattern(s).`);
    }

    const deduped = store.deduplicatePatterns();
    if (deduped > 0) {
      console.log(`📚 Deduplicated ${deduped} pattern(s).`);
    }
  }
}
