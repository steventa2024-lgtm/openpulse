import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { defaultSettingsMiddleware, wrapLanguageModel, type LanguageModel } from 'ai';
import { createOllama } from 'ollama-ai-provider-v2';
import type { OpenPulseConfig, ThinkingLevel } from '../config/schema.js';

export interface ModelRef {
  provider: string;
  model: string;
}

export class ModelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelConfigError';
  }
}

const BUILTIN: Record<
  string,
  { api: 'anthropic' | 'openai' | 'openai-compatible' | 'ollama'; baseUrl?: string; env?: string }
> = {
  anthropic: { api: 'anthropic', env: 'ANTHROPIC_API_KEY' },
  openai: { api: 'openai', env: 'OPENAI_API_KEY' },
  openrouter: {
    api: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    env: 'OPENROUTER_API_KEY',
  },
  // Ollama's native API, not its OpenAI-compatible one: only the native API accepts a context
  // size per request, and without it Ollama loads every model with a 4k window and silently
  // drops the start of longer prompts — the system prompt and the task.
  ollama: { api: 'ollama', baseUrl: 'http://127.0.0.1:11434' },
  lmstudio: { api: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1' },
};

/**
 * "anthropic/claude-opus-5" → {anthropic, claude-opus-5}. Split on the first "/" so ids that
 * contain slashes (openrouter/moonshotai/kimi-k2) keep them. Bare names resolve through
 * agents.defaults.models aliases, else default to anthropic.
 */
export function parseModelRef(ref: string, config?: OpenPulseConfig): ModelRef {
  const trimmed = ref.trim();
  if (config) {
    for (const [full, entry] of Object.entries(config.agents.defaults.models)) {
      if (entry.alias && entry.alias.toLowerCase() === trimmed.toLowerCase())
        return parseModelRef(full);
    }
  }
  const slash = trimmed.indexOf('/');
  if (slash <= 0) return { provider: 'anthropic', model: trimmed };
  return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) };
}

/** Context window OpenPulse asks Ollama for when a provider does not set contextTokens. */
export const OLLAMA_DEFAULT_CONTEXT = 16_384;

function apiFor(ref: ModelRef, config: OpenPulseConfig) {
  const custom = config.models.providers[ref.provider];
  return (
    custom?.api ?? BUILTIN[ref.provider]?.api ?? (custom?.baseUrl ? 'openai-compatible' : undefined)
  );
}

/**
 * The context window a model will actually get, when OpenPulse knows it: a provider's
 * contextTokens setting, or the window it requests from Ollama. Undefined means "large enough".
 */
export function contextWindowFor(ref: ModelRef, config: OpenPulseConfig): number | undefined {
  const configured = config.models.providers[ref.provider]?.contextTokens;
  if (configured) return configured;
  return apiFor(ref, config) === 'ollama' ? OLLAMA_DEFAULT_CONTEXT : undefined;
}

/** "http://host:11434", ".../v1" or ".../api" → "http://host:11434/api". */
export function ollamaApiBase(url: string): string {
  return `${url.replace(/\/+$/, '').replace(/\/(v1|api)$/, '')}/api`;
}

export function formatModelRef(ref: ModelRef): string {
  return `${ref.provider}/${ref.model}`;
}

export type ModelFactory = (ref: ModelRef, config: OpenPulseConfig) => LanguageModel;

export const createModel: ModelFactory = (ref, config) => {
  const custom = config.models.providers[ref.provider];
  const builtin = BUILTIN[ref.provider];
  const api = apiFor(ref, config);
  if (!api) {
    throw new ModelConfigError(
      `Unknown model provider "${ref.provider}". Configure models.providers.${ref.provider} with an api and baseUrl.`,
    );
  }
  const apiKey = custom?.apiKey ?? (builtin?.env ? process.env[builtin.env] : undefined);
  const baseURL = custom?.baseUrl ?? builtin?.baseUrl;

  switch (api) {
    case 'anthropic':
      if (!apiKey) throw missingKey(ref.provider, builtin?.env);
      return createAnthropic({ apiKey, ...(baseURL && { baseURL }) })(ref.model);
    case 'openai':
      if (!apiKey) throw missingKey(ref.provider, builtin?.env);
      return createOpenAI({ apiKey, ...(baseURL && { baseURL }) })(ref.model);
    case 'openai-compatible':
      if (!baseURL)
        throw new ModelConfigError(`models.providers.${ref.provider}.baseUrl is required.`);
      if (!apiKey && builtin?.env) throw missingKey(ref.provider, builtin.env);
      // includeUsage asks for token counts on streamed replies; Ollama and LM Studio send them.
      return createOpenAICompatible({
        name: ref.provider,
        baseURL,
        includeUsage: true,
        ...(apiKey && { apiKey }),
      })(ref.model);
    case 'ollama': {
      if (!baseURL)
        throw new ModelConfigError(`models.providers.${ref.provider}.baseUrl is required.`);
      const model = createOllama({
        baseURL: ollamaApiBase(baseURL),
        ...(apiKey && { headers: { Authorization: `Bearer ${apiKey}` } }),
      })(ref.model);
      return wrapLanguageModel({
        model,
        middleware: defaultSettingsMiddleware({
          settings: {
            providerOptions: { ollama: { options: { num_ctx: contextWindowFor(ref, config) } } },
          },
        }),
      });
    }
  }
};

function missingKey(provider: string, env?: string): ModelConfigError {
  return new ModelConfigError(
    `No API key for "${provider}". Run \`openpulse onboard\`, set ${env ?? 'an API key'} in the environment, or add models.providers.${provider}.apiKey to openpulse.json.`,
  );
}

const ADAPTIVE_CLAUDE = /claude-(opus|sonnet|fable|mythos)-(4-[6-9]|5)/;

/** Map a session thinking level to provider options. */
export function thinkingProviderOptions(
  ref: ModelRef,
  level: ThinkingLevel,
): Record<string, Record<string, unknown>> | undefined {
  if (ref.provider === 'anthropic' && ADAPTIVE_CLAUDE.test(ref.model)) {
    const effort = {
      off: 'low',
      minimal: 'low',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
    }[level];
    return { anthropic: { thinking: { type: 'adaptive', display: 'summarized' }, effort } };
  }
  if (ref.provider === 'openai' && /^(gpt-5|o\d)/.test(ref.model)) {
    const effort = {
      off: 'minimal',
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'high',
    }[level];
    return { openai: { reasoningEffort: effort, reasoningSummary: 'auto' } };
  }
  return undefined;
}

export function maxOutputTokensFor(ref: ModelRef): number | undefined {
  return ref.provider === 'anthropic' || ref.provider === 'openai' ? 32_000 : undefined;
}

export const KNOWN_MODELS: {
  ref: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
}[] = [
  {
    ref: 'anthropic/claude-opus-5',
    name: 'Claude Opus 5',
    provider: 'anthropic',
    contextWindow: 1_000_000,
    reasoning: true,
  },
  {
    ref: 'anthropic/claude-sonnet-5',
    name: 'Claude Sonnet 5',
    provider: 'anthropic',
    contextWindow: 1_000_000,
    reasoning: true,
  },
  {
    ref: 'anthropic/claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    provider: 'anthropic',
    contextWindow: 200_000,
  },
  { ref: 'openai/gpt-5', name: 'GPT-5', provider: 'openai', reasoning: true },
  { ref: 'ollama/qwen3:8b', name: 'Qwen3 8B (Ollama)', provider: 'ollama' },
];
