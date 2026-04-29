/* ────────────────────────────────────────────────────────────
   Loop heuristics — project-agnostic adaptive controls
   ──────────────────────────────────────────────────────────── */

export function isFatalToolError(toolResult: string): boolean {
  const fatalMarkers = [
    'SECURITY EXCEPTION',
    'Path is outside repo root',
    'Blocked unsafe path',
    'Unsupported tool',
    'Empty command',
  ];

  return fatalMarkers.some((marker) => toolResult.includes(marker));
}

export function isFatalRuntimeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  return ['AbortError', 'Model returned an empty response.'].some((marker) =>
    message.includes(marker),
  );
}

/* ────────────────────────────────────────────────────────────
   Information gain tracking
   ──────────────────────────────────────────────────────────── */

interface ToolCall {
  name: string;
  arg: string;
}

function parseToolHistory(toolHistory: string[]): ToolCall[] {
  return toolHistory.map((entry) => {
    const colonIdx = entry.indexOf(':');
    if (colonIdx === -1) return { name: entry, arg: '' };
    return { name: entry.slice(0, colonIdx), arg: entry.slice(colonIdx + 1) };
  });
}

/**
 * Detect spiral patterns — the agent is repeating the same sequence of tools
 * without making progress.
 */
export function detectSpiralPattern(toolHistory: string[]): boolean {
  if (toolHistory.length < 6) return false;

  // Check if the last 3 entries match the 3 before them (exact cycle)
  const recent = toolHistory.slice(-3);
  const prior = toolHistory.slice(-6, -3);

  if (recent.every((entry, i) => entry === prior[i])) {
    return true;
  }

  // Check if same tool+arg combo appears 4+ times (stuck on one call)
  const last = toolHistory[toolHistory.length - 1];
  const repeatCount = toolHistory.filter((e) => e === last).length;

  return repeatCount >= 4;
}

/**
 * Count how many unique files the agent has actually read.
 * This is the best proxy for "does the agent have enough context?"
 */
export function countUniqueFilesRead(toolHistory: string[]): number {
  const calls = parseToolHistory(toolHistory);
  const filesRead = new Set<string>();

  for (const call of calls) {
    if (call.name === 'read_file' && call.arg) {
      filesRead.add(call.arg);
    }
  }

  return filesRead.size;
}

/**
 * Measure information gain — are recent tool calls discovering new files
 * or re-reading the same ones?
 */
export function measureInformationGain(toolHistory: string[]): 'high' | 'low' | 'stale' {
  if (toolHistory.length < 4) return 'high';

  const recentWindow = toolHistory.slice(-4);
  const priorEntries = new Set(toolHistory.slice(0, -4));

  const newEntries = recentWindow.filter((e) => !priorEntries.has(e)).length;
  const ratio = newEntries / recentWindow.length;

  if (ratio >= 0.5) return 'high';
  if (ratio >= 0.25) return 'low';
  return 'stale';
}

/* ────────────────────────────────────────────────────────────
   Broad exploration detection (project-agnostic)
   ──────────────────────────────────────────────────────────── */

/**
 * Count tool calls that are broad, unfocused exploration —
 * search calls with very short/generic keywords, or repeated directory listings.
 */
export function countBroadExplorationCalls(toolHistory: string[]): number {
  const calls = parseToolHistory(toolHistory);
  let broadCount = 0;

  for (const call of calls) {
    // Short generic search keywords (1-5 chars) are usually unfocused
    if (call.name === 'search_project' && call.arg.length <= 5 && call.arg.length > 0) {
      broadCount++;
    }

    // Listing root or top-level dirs repeatedly
    if (call.name === 'list_directory' && (!call.arg || call.arg === '.')) {
      broadCount++;
    }

    // Generic grep patterns
    if (call.name === 'grep_code' && call.arg.length <= 4) {
      broadCount++;
    }
  }

  return broadCount;
}

/**
 * Determine if the agent has gathered enough context to attempt implementation.
 * Uses adaptive signals instead of hardcoded keywords.
 */
export function hasEnoughTargetEvidence(toolHistory: string[]): boolean {
  const calls = parseToolHistory(toolHistory);

  // Must have read at least 2 files (understanding existing code)
  const filesRead = countUniqueFilesRead(toolHistory);
  if (filesRead < 2) return false;

  // Must have done at least one search (discovered structure)
  const searches = calls.filter((c) =>
    ['search_project', 'grep_code', 'find_references'].includes(c.name),
  ).length;
  if (searches < 1) return false;

  // Combined evidence score
  const score = filesRead + searches;
  return score >= 4;
}

/* ────────────────────────────────────────────────────────────
   Combined loop control decision
   ──────────────────────────────────────────────────────────── */

export interface LoopControlDecision {
  shouldRedirect: boolean;
  reason: string;
}

/**
 * Main entry point for loop control decisions.
 * Returns whether the agent should stop exploring and start implementing.
 */
export function evaluateLoopControl(
  toolHistory: string[],
  iterationCount: number,
  totalTokens: number,
): LoopControlDecision {
  // Spiral detection — agent is stuck in a loop
  if (detectSpiralPattern(toolHistory)) {
    return {
      shouldRedirect: true,
      reason: 'Spiral pattern detected — you are repeating the same tool calls. Stop exploring and produce the implementation based on what you already know.',
    };
  }

  // Stale information gain — last few calls aren't discovering anything new
  const gain = measureInformationGain(toolHistory);
  if (gain === 'stale' && hasEnoughTargetEvidence(toolHistory)) {
    return {
      shouldRedirect: true,
      reason: 'Your recent tool calls are not discovering new information. You have enough context — produce the implementation now.',
    };
  }

  // Broad exploration threshold with evidence
  const broadCount = countBroadExplorationCalls(toolHistory);
  if (broadCount >= 3 && hasEnoughTargetEvidence(toolHistory)) {
    return {
      shouldRedirect: true,
      reason: 'You have enough context to implement the requested change. Stop broad exploration and produce the patch for the minimal valid implementation.',
    };
  }

  // Iteration-based progressive pressure
  if (iterationCount >= 15 && hasEnoughTargetEvidence(toolHistory)) {
    return {
      shouldRedirect: true,
      reason: `You have used ${iterationCount} iterations. Produce the implementation now with what you have gathered.`,
    };
  }

  // Hard iteration limit warning
  if (iterationCount >= 25) {
    return {
      shouldRedirect: true,
      reason: `Approaching iteration limit (${iterationCount}/100). You must produce the implementation immediately.`,
    };
  }

  return { shouldRedirect: false, reason: '' };
}
