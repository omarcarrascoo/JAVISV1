import { createDeepseekChatCompletion } from '../client.js';
import type {
  LLMProvider,
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMToolCall,
} from './types.js';

/**
 * DeepSeek provider — wraps the existing client.ts retry logic.
 */
export class DeepSeekProvider implements LLMProvider {
  readonly name = 'deepseek';

  isAvailable(): boolean {
    return Boolean(process.env.DEEPSEEK_API_KEY);
  }

  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    const response = await createDeepseekChatCompletion(
      {
        model: request.model,
        messages: request.messages as any,
        temperature: request.temperature ?? 0,
        max_tokens: request.maxTokens ?? 4096,
        tools: request.tools as any,
        ...(request.responseFormat ? { response_format: request.responseFormat } : {}),
      },
      { signal: request.signal },
    );

    const message = response.choices?.[0]?.message;

    const toolCalls: LLMToolCall[] = (message?.tool_calls || [])
      .filter((tc: any) => tc?.function)
      .map((tc: any) => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments || '{}',
        },
      }));

    return {
      content: message?.content ?? null,
      toolCalls,
      usage: {
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
        totalTokens: response.usage?.total_tokens ?? 0,
      },
      raw: response,
    };
  }
}
