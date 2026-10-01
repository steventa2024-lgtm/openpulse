/** What models.detect reports, as far as first-run setup needs it. */
export interface DetectSnapshot {
  local: {
    id: string;
    label: string;
    running: boolean;
    installed: boolean;
    models: {
      id: string;
      ref: string;
      label: string;
      supportsTools?: boolean;
      sizeBytes?: number;
    }[];
  }[];
  hosted: { id: string; label: string; configured: boolean }[];
  current: { primary: string };
}

export type ModelReadiness =
  | { state: 'ready'; detail: string }
  | { state: 'needs-key'; detail: string; suggestion?: string }
  | { state: 'not-running'; detail: string; suggestion?: string }
  | { state: 'not-installed'; detail: string; suggestion?: string }
  | { state: 'unknown'; detail: string };

/**
 * Whether the default model can answer, judged from what the gateway detected: a local model must
 * be installed on a running server, a hosted one needs its API key. When it can't, `suggestion` is
 * a local model that is installed right now: one that can call tools, and of those the one whose
 * size is nearest a typical laptop's comfortable ~5 GB (big models are slow; tiny ones fumble tools).
 */
export function modelReadiness(detect: DetectSnapshot): ModelReadiness {
  const primary = detect.current.primary;
  const slash = primary.indexOf('/');
  const provider = slash > 0 ? primary.slice(0, slash) : 'anthropic';
  const model = slash > 0 ? primary.slice(slash + 1) : primary;

  const COMFORTABLE_BYTES = 5 * 1024 ** 3;
  const distance = (m: { sizeBytes?: number }) =>
    m.sizeBytes ? Math.abs(Math.log(m.sizeBytes / COMFORTABLE_BYTES)) : Number.POSITIVE_INFINITY;
  const available = detect.local
    .filter((p) => p.running)
    .flatMap((p) => p.models)
    .sort(
      (a, b) =>
        Number(b.supportsTools === true) - Number(a.supportsTools === true) ||
        distance(a) - distance(b),
    );
  const suggestion = available.find((m) => m.ref !== primary)?.ref;
  const withSuggestion = <T extends object>(value: T) =>
    suggestion ? { ...value, suggestion } : value;

  const local = detect.local.find((p) => p.id === provider);
  if (local) {
    if (!local.running) {
      return withSuggestion({
        state: 'not-running' as const,
        detail: `${local.label} is not running, so ${primary} cannot answer.`,
      });
    }
    if (!local.models.some((m) => m.id === model || m.ref === primary)) {
      return withSuggestion({
        state: 'not-installed' as const,
        detail: `${model} is not installed in ${local.label}.`,
      });
    }
    return { state: 'ready', detail: `${primary} is installed and ${local.label} is running.` };
  }

  const hosted = detect.hosted.find((p) => p.id === provider);
  if (hosted) {
    if (!hosted.configured) {
      return withSuggestion({
        state: 'needs-key' as const,
        detail: `${primary} needs an API key for ${hosted.label}, and none is set.`,
      });
    }
    return { state: 'ready', detail: `${primary} with your ${hosted.label} API key.` };
  }

  return { state: 'unknown', detail: `${primary} uses a provider set up in your configuration.` };
}
