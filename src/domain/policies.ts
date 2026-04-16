export interface GatePolicy {
  runTypecheck: boolean;
  runLint: boolean;
  runTests: boolean;
  runBuild: boolean;
  runRuntime: boolean;
  requireRuntimeForUi: boolean;
  captureSnapshot: boolean;
  /** Scan for hardcoded secrets/credentials in scope */
  runSecurityScan: boolean;
  /** Detect circular import chains in scope */
  runImportCycleCheck: boolean;
}

export interface AutonomousRunPolicy {
  integrationBranchName: string;
  autoApprovePlan: boolean;
  maxParallelTasks: number;
  maxRetriesPerTask: number;
  maxImprovementCycles: number;
  maxHours: number;
  maxCommits: number;
  /** Max tokens across all tasks in a single run (0 = unlimited) */
  maxTokensPerRun: number;
  /** Max tokens for a single task execution (0 = unlimited) */
  maxTokensPerTask: number;
  gates: GatePolicy;
}

export interface NightJobConfig {
  maxHours: number;
  maxCommits: number;
  maxParallelTasks: number;
  maxRetriesPerTask: number;
}
