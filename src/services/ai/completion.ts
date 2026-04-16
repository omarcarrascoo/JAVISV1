/**
 * Unified completion layer — combines model router, provider registry,
 * and token tracking into a single entry point.
 *
 * Call sites use `roleCompletion(role, request)` instead of
 * directly calling `createDeepseekChatCompletion`. The router
 * picks the model/provider, and token usage is tracked automatically.
 */

import type { AgentRole } from './model-router.js';
import { getModelConfig } from './model-router.js';
import { resolveProvider } from './providers/provider-registry.js';
import type { LLMCompletionRequest, LLMCompletionResponse, LLMMessage, LLMToolDefinition } from './providers/types.js';
import { getTokenTracker } from './token-tracker.js';

export interface RoleCompletionRequest {
  messages: LLMMessage[];
  tools?: LLMToolDefinition[];
  responseFormat?: { type: 'json_object' };
  signal?: AbortSignal;
  /** Override temperature for this specific call */
  temperature?: number;
  /** Override max tokens for this specific call */
  maxTokens?: number;
  /** For token tracking */
  runId?: string;
  taskId?: string;
}

/**
 * Execute a completion using the model router.
 * Automatically selects the right model/provider for the given role.
 */
export async function roleCompletion(
  role: AgentRole,
  request: RoleCompletionRequest,
): Promise<LLMCompletionResponse> {
  const config = getModelConfig(role);
  const provider = resolveProvider(config.provider);

  const llmRequest: LLMCompletionRequest = {
    model: config.model,
    messages: request.messages,
    temperature: request.temperature ?? config.temperature,
    maxTokens: request.maxTokens ?? config.maxTokens,
    tools: request.tools,
    responseFormat: request.responseFormat,
    signal: request.signal,
  };

  const response = await provider.complete(llmRequest);

  // Track token usage (budget enforcement disabled for now — log only)
  if (request.runId) {
    const tracker = getTokenTracker();
    const budgetCheck = tracker.record(request.runId, request.taskId ?? null, response.usage.totalTokens);

    if (budgetCheck.status === 'warning' && budgetCheck.message) {
      console.warn(`⚠️ Token budget: ${budgetCheck.message}`);
    }
  }

  return response;
}
