 Evolution Plan — Remaining Gaps & Step-by-Step Implementation                                                                                                                                            
                                                        
 Context

 The main-refactor branch contains a massive leap from POC to production-grade autonomous orchestrator. After thorough analysis, ~95% of the evolution plan (Phases 0-8) is already implemented in the
 current uncommitted changes. This plan covers only what's actually missing.

 What's Already Done (no work needed)

 - Phase 0: Shell injection fix, DB indexes, worktree manager
 - Phase 1: 8 agent tools in src/tools.ts, loop heuristics with spiral detection
 - Phase 2: Fuzzy edit matching (0.85), atomic transactions, line-range editing
 - Phase 3: Cherry-pick conflict resolution, TaskQueue, checkpoint/resume, push retry (exponential backoff)
 - Phase 4: Model router (7 roles), provider abstraction (DeepSeek), token budget (2M/run, 500K/task)
 - Phase 5: Runtime gate config, security scan (regex-based), import cycle DFS, parallel gate execution
 - Phase 6: Learning store + pattern extractor + prompt injector (data flow IS wired)
 - Phase 7: Discord commands (/status, /policy with presets, /cost, /learning), HTTP console with graph/diff/timeline
 - Phase 8: Explorer->Architect->Implementer pipeline, multi-repo with Kahn's topo sort, knowledge graph with SQLite

 ---
 Remaining Work — 5 Steps

 Step 1: Data Quality Fixes (3 small code changes)

 1a. Pre-edit file re-read validation
 - File: src/services/ai/edit-operations.ts (~line 244)
 - Gap: When applying search/replace, the file is read once. If a prior task modified the same file, the search block may be stale.
 - Fix: Before applying each edit, re-read the file from disk and validate the search block still exists. On mismatch, return the CURRENT content in the error so the agent can self-correct.
 - Impact: Prevents the write_file/search_replace collision pattern seen in the Help screen task (37 iterations wasted).

 1b. Explicit filesRead tracking in agent-runner
 - File: src/services/ai/agent-runner.ts (~line 53-98)
 - Gap: filesRead is extracted by parsing toolHistory strings heuristically (read_file:path). If tool names change or args use different param names, reads are missed.
 - Fix: Add a dedicated filesRead: Set<string> alongside toolHistory. When a read_file tool call executes, explicitly add the path. Return it in the result alongside toolHistory.
 - File: src/application/run-autonomous-agent.ts (~line 689)
 - Fix: Use execution.filesRead directly instead of parsing from toolHistory.

 1c. Pattern temporal decay
 - File: src/services/learning/learning-store.ts
 - Gap: Old patterns never lose relevance by age — only by poor effectiveness scores. A pattern from 6 months ago has equal weight to one from yesterday.
 - Fix: Add an age_factor to relevance scoring: ageFactor = Math.max(0.3, 1 - (daysSinceCreation / 90)). Patterns older than 90 days have 30% base weight. Apply as multiplier on the final relevance
 score.

 ---
 Step 2: Observability API Endpoints (HTTP server expansion)

 File: src/transports/http/server.ts

 Add these missing endpoints to expose data that's already collected but hidden:

 ┌───────────────────────────────────────────┬─────────────────────────────────┬───────────────────────────────────────────┐
 │                 Endpoint                  │             Source              │                  Purpose                  │
 ├───────────────────────────────────────────┼─────────────────────────────────┼───────────────────────────────────────────┤
 │ GET /api/telemetry/gate-stats?project=X   │ telemetry-store + new query     │ Gate pass/fail rates across runs          │
 ├───────────────────────────────────────────┼─────────────────────────────────┼───────────────────────────────────────────┤
 │ GET /api/telemetry/edit-metrics?project=X │ telemetry-store + new query     │ Edit success/failure/fuzzy-match rates    │
 ├───────────────────────────────────────────┼─────────────────────────────────┼───────────────────────────────────────────┤
 │ GET /api/runs/:id/task-costs              │ telemetry-store.getTaskCosts()  │ Per-task cost with model breakdown        │
 ├───────────────────────────────────────────┼─────────────────────────────────┼───────────────────────────────────────────┤
 │ GET /api/knowledge/modules?project=X      │ knowledge-graph.listModules()   │ Module list with deps/dependents          │
 ├───────────────────────────────────────────┼─────────────────────────────────┼───────────────────────────────────────────┤
 │ GET /api/knowledge/file-changes?project=X │ knowledge-graph + new query     │ File change history with task attribution │
 ├───────────────────────────────────────────┼─────────────────────────────────┼───────────────────────────────────────────┤
 │ GET /api/policies/:project                │ unity-store.getPolicy()         │ Read project policy                       │
 ├───────────────────────────────────────────┼─────────────────────────────────┼───────────────────────────────────────────┤
 │ PUT /api/policies/:project                │ unity-store.upsertPolicy()      │ Update project policy                     │
 ├───────────────────────────────────────────┼─────────────────────────────────┼───────────────────────────────────────────┤
 │ GET /api/runs/resumable                   │ unity-store.listResumableRuns() │ List crash-interrupted runs               │
 ├───────────────────────────────────────────┼─────────────────────────────────┼───────────────────────────────────────────┤
 │ GET /api/runs/:id/plans                   │ unity-store.listPlansByRun()    │ Plan version history                      │
 └───────────────────────────────────────────┴─────────────────────────────────┴───────────────────────────────────────────┘

 New queries needed (add to src/services/telemetry/telemetry-store.ts):
 - getGateStats(projectName, days) — aggregate gate pass/fail/skip counts by gate name
 - getEditMetrics(projectName, days) — count of edit.applied vs edit.failed events, fuzzy match count

 New query needed (add to src/services/knowledge/knowledge-graph.ts):
 - getFileChangesWithAttribution(projectName, limit) — join file_change_log with task info

 ---
 Step 3: Console UI — Telemetry & Analytics Dashboard

 File: src/transports/http/server.ts

 Add a new HTML page at /analytics (or /dashboard) that visualizes the data from Step 2. Server-side rendered like the existing run pages.

 Sections:
 1. Cost Overview — Total spend, cost per run trend, cost per model pie chart
 2. Gate Health — Bar chart of pass/fail rates per gate (typecheck, lint, test, build, security, import-cycles)
 3. Edit Reliability — Success rate, fuzzy match save rate, failure reasons
 4. Learning Effectiveness — Pattern count, application success rate, top patterns table
 5. Hot Files — Top 20 most-changed files with failure counts
 6. Fragile Areas — Modules ranked by fragility score

 Implementation: Use the same server-side HTML rendering pattern as renderRunPage(). Fetch data from the new API endpoints via JavaScript on load. Use simple CSS-based charts (progress bars, tables) —
 no external charting library needed.

 ---
 Step 4: Console UI — Knowledge Graph & Settings Pages

 4a. Knowledge page at /knowledge
 - Module list with dependency counts and fragility scores
 - Architecture decisions timeline
 - File change attribution table (which task changed which file, with gate results)

 4b. Settings page at /settings
 - Current policy display with editable fields
 - Policy preset buttons (conservative/balanced/aggressive)
 - POST to /api/policies/:project on save

 4c. Learning page at /learning
 - Pattern browser: list patterns with effectiveness scores, times applied, task kind
 - Project learning stats
 - Filter by project, task kind, effectiveness threshold

 ---
 Step 5: Knowledge Graph Auto-Population

 File: src/services/knowledge/knowledge-graph.ts

 Gap: The knowledge graph only updates post-run. On first run for a new project, it has zero data — Explorer has no fragility or hot file context.

 Fix: Add scanProjectStructure(projectName, repoPath):
 1. Walk the source tree, classify modules by inferModuleType()
 2. Build import graph (reuse buildImportGraph() from gates.ts — extract to shared util)
 3. Populate modules table with dependency/dependent relationships
 4. Detect API endpoints (scan for route decorators/Express routes)
 5. Call this on first prepareWorkspace() if the knowledge graph has 0 modules for that project

 File: src/services/orchestration/gates.ts — extract buildImportGraph() and resolveImportPath() to a shared module (e.g., src/shared/import-graph.ts) so knowledge-graph.ts can reuse them without
 circular deps.

 ---
 Files Modified Per Step

 ┌──────┬─────────────────────────────────────────────────────────────────┬────────────────────────────┐
 │ Step │                              Files                              │         New Files          │
 ├──────┼─────────────────────────────────────────────────────────────────┼────────────────────────────┤
 │ 1a   │ edit-operations.ts                                              │ —                          │
 ├──────┼─────────────────────────────────────────────────────────────────┼────────────────────────────┤
 │ 1b   │ agent-runner.ts, run-autonomous-agent.ts                        │ —                          │
 ├──────┼─────────────────────────────────────────────────────────────────┼────────────────────────────┤
 │ 1c   │ learning-store.ts                                               │ —                          │
 ├──────┼─────────────────────────────────────────────────────────────────┼────────────────────────────┤
 │ 2    │ server.ts, telemetry-store.ts, knowledge-graph.ts               │ —                          │
 ├──────┼─────────────────────────────────────────────────────────────────┼────────────────────────────┤
 │ 3    │ server.ts                                                       │ —                          │
 ├──────┼─────────────────────────────────────────────────────────────────┼────────────────────────────┤
 │ 4    │ server.ts                                                       │ —                          │
 ├──────┼─────────────────────────────────────────────────────────────────┼────────────────────────────┤
 │ 5    │ knowledge-graph.ts, gates.ts, git.ts or run-autonomous-agent.ts │ src/shared/import-graph.ts │
 └──────┴─────────────────────────────────────────────────────────────────┴────────────────────────────┘

 Verification

 After each step:
 - Step 1: Run the agent against a test task, verify filesRead is populated in learning patterns. Check that stale edits show the current file content in error. Verify old patterns have lower relevance
  scores.
 - Step 2: curl each new endpoint and verify JSON responses. Check that gate stats, edit metrics, and policy CRUD work.
 - Step 3: Open http://localhost:<port>/analytics and verify all sections render with real data from past runs.
 - Step 4: Open /knowledge, /settings, /learning pages. Verify settings persist after save.
 - Step 5: Delete knowledge DB, run prepareWorkspace() for a project, verify modules table is populated before any agent run.

 Execution Order

 Steps 1-5 are independent of each other. Recommended order:
 1. Step 1 first — smallest changes, biggest reliability impact
 2. Step 2 next — unlocks Steps 3-4
 3. Steps 3-4 can be done in parallel
 4. Step 5 last — nice-to-have, least urgent