/**
 * Provider abstraction types.
 *
 * All LLM providers implement the LLMProvider interface,
 * allowing the system to swap between DeepSeek, Anthropic, OpenAI, etc.
 */

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: LLMToolCall[];
}

export interface LLMToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface LLMToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LLMCompletionRequest {
  model: string;
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: LLMToolDefinition[];
  responseFormat?: { type: 'json_object' };
  signal?: AbortSignal;
}

export interface LLMCompletionResponse {
  content: string | null;
  toolCalls: LLMToolCall[];
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** Raw provider-specific response for edge cases */
  raw?: unknown;
}

export interface LLMProvider {
  readonly name: string;

  /**
   * Send a completion request to the provider.
   * Handles retries internally.
   */
  complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse>;

  /**
   * Check if this provider is configured (API key available, etc).
   */
  isAvailable(): boolean;
}
