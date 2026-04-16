/**
 * Model Router — maps agent roles to model configurations.
 *
 * Each role (planning, code-gen, review, etc.) gets a model tier
 * with appropriate temperature, token limits, and provider hints.
 */

export type AgentRole =
  | 'planning'
  | 'code-gen'
  | 'review'
  | 'pr-metadata'
  | 'repair'
  | 'explorer'
  | 'architect';

export type ModelTier = 'reasoning' | 'chat' | 'fast';

export interface ModelConfig {
  /** Model identifier (e.g. 'deepseek-reasoner', 'deepseek-chat') */
  model: string;
  /** Provider key for the provider registry */
  provider: string;
  /** Default temperature for this role */
  temperature: number;
  /** Default max output tokens */
  maxTokens: number;
  /** Model tier classification */
  tier: ModelTier;
}

/**
 * Default role-to-model mapping.
 * Code-gen and PR metadata use the reasoning model for higher quality.
 * Planning and review use the chat model for speed and cost.
 * Repair (JSON fix-up) uses chat with low temperature.
 */
const DEFAULT_MODEL_MAP: Record<AgentRole, ModelConfig> = {
  'code-gen': {
    model: 'deepseek-reasoner',
    provider: 'deepseek',
    temperature: 0.1,
    maxTokens: 8192,
    tier: 'reasoning',
  },
  'pr-metadata': {
    model: 'deepseek-reasoner',
    provider: 'deepseek',
    temperature: 0.3,
    maxTokens: 500,
    tier: 'reasoning',
  },
  planning: {
    model: 'deepseek-chat',
    provider: 'deepseek',
    temperature: 0.2,
    maxTokens: 2200,
    tier: 'chat',
  },
  review: {
    model: 'deepseek-chat',
    provider: 'deepseek',
    temperature: 0,
    maxTokens: 1800,
    tier: 'chat',
  },
  repair: {
    model: 'deepseek-chat',
    provider: 'deepseek',
    temperature: 0,
    maxTokens: 900,
    tier: 'chat',
  },
  explorer: {
    model: 'deepseek-chat',
    provider: 'deepseek',
    temperature: 0.1,
    maxTokens: 4096,
    tier: 'chat',
  },
  architect: {
    model: 'deepseek-reasoner',
    provider: 'deepseek',
    temperature: 0.2,
    maxTokens: 4096,
    tier: 'reasoning',
  },
};

/** Runtime overrides set via `configureModelRouter`. */
let overrides: Partial<Record<AgentRole, Partial<ModelConfig>>> = {};

/**
 * Get the model configuration for a given agent role.
 * Merges any runtime overrides on top of the defaults.
 */
export function getModelConfig(role: AgentRole): ModelConfig {
  const base = DEFAULT_MODEL_MAP[role];
  const override = overrides[role];

  if (!override) return base;

  return { ...base, ...override };
}

/**
 * Apply runtime overrides for one or more roles.
 * Typically called at startup based on env vars or policy.
 */
export function configureModelRouter(
  config: Partial<Record<AgentRole, Partial<ModelConfig>>>,
): void {
  overrides = { ...overrides, ...config };
}

/**
 * Reset all overrides (mainly for testing).
 */
export function resetModelRouter(): void {
  overrides = {};
}

/**
 * List all current model configurations (defaults + overrides).
 */
export function listModelConfigs(): Record<AgentRole, ModelConfig> {
  const roles: AgentRole[] = ['planning', 'code-gen', 'review', 'pr-metadata', 'repair', 'explorer', 'architect'];
  const result = {} as Record<AgentRole, ModelConfig>;
  for (const role of roles) {
    result[role] = getModelConfig(role);
  }
  return result;
}
