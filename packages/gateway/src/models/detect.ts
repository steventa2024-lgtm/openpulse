export interface DetectedModel {
  /** Model id as the provider knows it, e.g. "qwen3:8b". */
  id: string;
  /** The ref to put in openpulse.json, e.g. "ollama/qwen3:8b". */
  ref: string;
  label: string;
  sizeBytes?: number;
  family?: string;
  parameterSize?: string;
  quantisation?: string;
  contextLength?: number;
  /** Whether the provider advertises tool calling for this model. */
  supportsTools?: boolean;
  modifiedAt?: string;
}

export interface ProviderProbe {
  id: 'ollama' | 'lmstudio';
  label: string;
  /** Where we looked. */
  baseUrl: string;
  installed: boolean;
  running: boolean;
  version?: string;
  models: DetectedModel[];
  error?: string;
  /** What to do about it, when something is missing. */
  hint?: string;
}

export interface DetectOptions {
  fetchFn?: typeof fetch;
  ollamaUrl?: string;
  lmStudioUrl?: string;
  timeoutMs?: number;
}

const OLLAMA_DEFAULT = 'http://127.0.0.1:11434';
const LM_STUDIO_DEFAULT = 'http://127.0.0.1:1234';

/** Probe the local inference servers OpenPulse can use without an API key. */
export async function detectLocalProviders(options: DetectOptions = {}): Promise<ProviderProbe[]> {
  return Promise.all([detectOllama(options), detectLmStudio(options)]);
}

export async function detectOllama(options: DetectOptions = {}): Promise<ProviderProbe> {
  const fetchFn = options.fetchFn ?? fetch;
  const baseUrl = (options.ollamaUrl ?? process.env.OLLAMA_HOST ?? OLLAMA_DEFAULT).replace(
    /\/$/,
    '',
  );
  const probe: ProviderProbe = {
    id: 'ollama',
    label: 'Ollama',
    baseUrl,
    installed: false,
    running: false,
    models: [],
  };

  try {
    const response = await fetchFn(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 3_000),
    });
    if (!response.ok) {
      probe.error = `Ollama answered ${response.status}`;
      probe.hint = 'Check that the Ollama service is healthy, then try again.';
      return probe;
    }
    const body = (await response.json()) as {
      models?: {
        name?: string;
        model?: string;
        size?: number;
        modified_at?: string;
        details?: { family?: string; parameter_size?: string; quantization_level?: string };
      }[];
    };
    probe.installed = true;
    probe.running = true;
    probe.models = (body.models ?? []).map((model) => {
      const id = model.model ?? model.name ?? '';
      return {
        id,
        ref: `ollama/${id}`,
        label: id,
        ...(model.size !== undefined && { sizeBytes: model.size }),
        ...(model.details?.family && { family: model.details.family }),
        ...(model.details?.parameter_size && { parameterSize: model.details.parameter_size }),
        ...(model.details?.quantization_level && {
          quantisation: model.details.quantization_level,
        }),
        ...(model.modified_at && { modifiedAt: model.modified_at }),
      };
    });

    const version = await fetchFn(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(2_000) })
      .then((r) => (r.ok ? (r.json() as Promise<{ version?: string }>) : undefined))
      .catch(() => undefined);
    if (version?.version) probe.version = version.version;

    if (probe.models.length === 0) {
      probe.hint =
        'Ollama is running but has no models. Pull one, for example: ollama pull qwen3:8b';
    }
    return probe;
  } catch (error) {
    probe.error =
      (error as Error).name === 'TimeoutError'
        ? 'Ollama did not answer in time'
        : 'Ollama is not running';
    probe.hint = `Start Ollama (it listens on ${baseUrl}), or install it from https://ollama.com`;
    return probe;
  }
}

export async function detectLmStudio(options: DetectOptions = {}): Promise<ProviderProbe> {
  const fetchFn = options.fetchFn ?? fetch;
  const baseUrl = (options.lmStudioUrl ?? LM_STUDIO_DEFAULT).replace(/\/$/, '');
  const probe: ProviderProbe = {
    id: 'lmstudio',
    label: 'LM Studio',
    baseUrl,
    installed: false,
    running: false,
    models: [],
  };

  try {
    const response = await fetchFn(`${baseUrl}/v1/models`, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 3_000),
    });
    if (!response.ok) {
      probe.error = `LM Studio answered ${response.status}`;
      return probe;
    }
    const body = (await response.json()) as { data?: { id?: string; object?: string }[] };
    probe.installed = true;
    probe.running = true;
    probe.models = (body.data ?? [])
      .filter((model) => model.id)
      .map((model) => ({ id: model.id!, ref: `lmstudio/${model.id!}`, label: model.id! }));
    if (probe.models.length === 0) {
      probe.hint = 'LM Studio is running but has no model loaded. Load one on its Developer tab.';
    }
    return probe;
  } catch {
    probe.error = 'LM Studio is not running';
    probe.hint = `Open LM Studio, load a model and start its local server on ${baseUrl}`;
    return probe;
  }
}

export interface ModelDetails {
  ref: string;
  contextLength?: number;
  /** Ollama reports the family and template, which tells us whether tools are usable. */
  supportsTools?: boolean;
  family?: string;
  parameters?: Record<string, string>;
  warnings: string[];
}

/**
 * Ask Ollama about one model: its context window, and whether its template supports tool calling.
 *
 * A small context window is the single most common reason a local model fails on real work, so it
 * is surfaced as a warning rather than left to be discovered mid-run.
 */
export async function inspectOllamaModel(
  model: string,
  options: DetectOptions = {},
): Promise<ModelDetails> {
  const fetchFn = options.fetchFn ?? fetch;
  const baseUrl = (options.ollamaUrl ?? process.env.OLLAMA_HOST ?? OLLAMA_DEFAULT).replace(
    /\/$/,
    '',
  );
  const details: ModelDetails = { ref: `ollama/${model}`, warnings: [] };

  const response = await fetchFn(`${baseUrl}/api/show`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  }).catch(() => undefined);

  if (!response?.ok) {
    details.warnings.push('Could not read this model’s details from Ollama.');
    return details;
  }

  const body = (await response.json()) as {
    details?: { family?: string };
    model_info?: Record<string, unknown>;
    template?: string;
    capabilities?: string[];
    parameters?: string;
  };

  if (body.details?.family) details.family = body.details.family;

  const contextEntry = Object.entries(body.model_info ?? {}).find(([key]) =>
    key.endsWith('.context_length'),
  );
  if (contextEntry && typeof contextEntry[1] === 'number') details.contextLength = contextEntry[1];

  const capabilities = body.capabilities ?? [];
  details.supportsTools =
    capabilities.includes('tools') || /\.Tools|tool_calls/.test(body.template ?? '');

  if (details.supportsTools === false) {
    details.warnings.push(
      'This model does not advertise tool calling, so the agent cannot use its tools with it.',
    );
  }
  // Ollama serves a 4k window by default whatever the model supports.
  const served = Number(process.env.OLLAMA_CONTEXT_LENGTH ?? 0);
  if (served > 0 && served < 16_000) {
    details.warnings.push(
      `Ollama is serving a ${served}-token context. OpenPulse prompts need at least 32k; set OLLAMA_CONTEXT_LENGTH=32768.`,
    );
  } else if (!served) {
    details.warnings.push(
      'Ollama defaults to a small context window. Set OLLAMA_CONTEXT_LENGTH=32768 before starting it.',
    );
  }
  if (details.contextLength && details.contextLength < 16_000) {
    details.warnings.push(
      `This model tops out at ${details.contextLength} tokens, which is tight for agent work.`,
    );
  }

  if (typeof body.parameters === 'string') {
    details.parameters = Object.fromEntries(
      body.parameters
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [key = '', ...rest] = line.trim().split(/\s+/);
          return [key, rest.join(' ')];
        }),
    );
  }
  return details;
}
