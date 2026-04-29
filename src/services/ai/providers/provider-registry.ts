import type { LLMProvider } from './types.js';
import { DeepSeekProvider } from './deepseek-provider.js';

/**
 * Provider Registry — manages LLM provider instances and failover.
 *
 * Providers are registered by name. The `resolve` method picks the
 * requested provider, falling back to the next available one if
 * the primary isn't configured.
 */

const providers = new Map<string, LLMProvider>();
let fallbackOrder: string[] = ['deepseek'];

function ensureDefaults(): void {
  if (providers.size === 0) {
    providers.set('deepseek', new DeepSeekProvider());
  }
}

/**
 * Register a custom provider (e.g., Anthropic, OpenAI).
 */
export function registerProvider(provider: LLMProvider): void {
  providers.set(provider.name, provider);
}

/**
 * Set the failover order for providers.
 * The first available provider in the list is used when the requested one is unavailable.
 */
export function setFallbackOrder(order: string[]): void {
  fallbackOrder = order;
}

/**
 * Resolve a provider by name, with automatic failover.
 * Throws if no available provider can be found.
 */
export function resolveProvider(preferredName: string): LLMProvider {
  ensureDefaults();

  const preferred = providers.get(preferredName);
  if (preferred?.isAvailable()) {
    return preferred;
  }

  // Try fallback order
  for (const name of fallbackOrder) {
    if (name === preferredName) continue;
    const fallback = providers.get(name);
    if (fallback?.isAvailable()) {
      console.warn(`Provider "${preferredName}" unavailable, falling back to "${name}".`);
      return fallback;
    }
  }

  // Last resort: any available provider
  for (const [name, provider] of providers) {
    if (provider.isAvailable()) {
      console.warn(`Provider "${preferredName}" unavailable, using "${name}" as last resort.`);
      return provider;
    }
  }

  throw new Error(
    `No LLM provider available. Requested "${preferredName}", fallback order: [${fallbackOrder.join(', ')}]. ` +
    'Check that at least one API key is configured.',
  );
}

/**
 * List all registered providers and their availability.
 */
export function listProviders(): Array<{ name: string; available: boolean }> {
  ensureDefaults();
  return Array.from(providers.entries()).map(([name, provider]) => ({
    name,
    available: provider.isAvailable(),
  }));
}
