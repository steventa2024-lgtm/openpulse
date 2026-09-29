import fsp from 'node:fs/promises';
import path from 'node:path';

export interface RunRecord {
  ts: number;
  runId: string;
  sessionKey: string;
  /** Model ref actually used for the run, e.g. "anthropic/claude-opus-5". */
  model: string;
  provider: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  /** Prompt size at the last step, when the provider reports it. */
  contextTokens?: number;
  status: 'ok' | 'error' | 'aborted';
  error?: string;
  /** Where the turn came from: user, heartbeat, cron, workflow. */
  source?: string;
}

export interface ToolRecord {
  ts: number;
  runId: string;
  sessionKey: string;
  tool: string;
  durationMs: number;
  isError: boolean;
}

export interface ModelSummary {
  model: string;
  provider: string;
  runs: number;
  errors: number;
  aborted: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  /** Milliseconds. */
  averageDurationMs: number;
  p95DurationMs: number;
  lastUsedAt: number;
}

export interface TelemetrySummary {
  since: number;
  runs: number;
  errors: number;
  aborted: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  models: ModelSummary[];
  topTools: { tool: string; calls: number; errors: number; averageDurationMs: number }[];
  /** Runs per hour for the last 24 hours, oldest first. */
  activity: { hour: number; runs: number; errors: number }[];
}

const MAX_MEMORY_RECORDS = 5_000;

/**
 * What the runtime actually measured.
 *
 * Only values the agent loop produces are recorded — token counts as reported by the provider,
 * wall-clock duration, tool calls, errors. Nothing is estimated or inferred, so a provider that
 * reports no usage (most local models) shows zero tokens rather than a guess.
 */
export class TelemetryStore {
  private runs: RunRecord[] = [];
  private tools: ToolRecord[] = [];
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    readonly dir: string,
    private readonly options: { persist?: boolean } = {},
  ) {}

  /** Load recent history so the dashboard is not empty after a restart. */
  async load(limit = MAX_MEMORY_RECORDS): Promise<void> {
    const file = path.join(this.dir, 'runs.jsonl');
    const text = await fsp.readFile(file, 'utf8').catch(() => '');
    if (!text) return;
    const lines = text.split('\n').filter(Boolean).slice(-limit);
    this.runs = lines
      .map((line) => {
        try {
          return JSON.parse(line) as RunRecord;
        } catch {
          return undefined;
        }
      })
      .filter((record): record is RunRecord => Boolean(record?.runId));
  }

  recordRun(record: RunRecord): void {
    this.runs.push(record);
    if (this.runs.length > MAX_MEMORY_RECORDS) this.runs.shift();
    if (this.options.persist !== false) this.append('runs.jsonl', record);
  }

  recordTool(record: ToolRecord): void {
    this.tools.push(record);
    if (this.tools.length > MAX_MEMORY_RECORDS) this.tools.shift();
  }

  /** Raw run records, newest first, optionally filtered. */
  list(
    filter: { model?: string; sessionKey?: string; limit?: number; since?: number } = {},
  ): RunRecord[] {
    const limit = Math.min(filter.limit ?? 200, MAX_MEMORY_RECORDS);
    return this.runs
      .filter((run) => !filter.model || run.model === filter.model)
      .filter((run) => !filter.sessionKey || run.sessionKey === filter.sessionKey)
      .filter((run) => !filter.since || run.ts >= filter.since)
      .slice(-limit)
      .reverse();
  }

  summary(options: { since?: number; sessionKey?: string } = {}): TelemetrySummary {
    const since = options.since ?? 0;
    const runs = this.runs
      .filter((run) => run.ts >= since)
      .filter((run) => !options.sessionKey || run.sessionKey === options.sessionKey);

    const byModel = new Map<string, RunRecord[]>();
    for (const run of runs) {
      const list = byModel.get(run.model) ?? [];
      list.push(run);
      byModel.set(run.model, list);
    }

    const models: ModelSummary[] = [...byModel.entries()].map(([model, records]) => {
      const durations = records.map((r) => r.durationMs).sort((a, b) => a - b);
      return {
        model,
        provider: records[0]?.provider ?? model.split('/')[0] ?? '',
        runs: records.length,
        errors: records.filter((r) => r.status === 'error').length,
        aborted: records.filter((r) => r.status === 'aborted').length,
        inputTokens: sum(records.map((r) => r.inputTokens)),
        outputTokens: sum(records.map((r) => r.outputTokens)),
        toolCalls: sum(records.map((r) => r.toolCalls)),
        averageDurationMs: durations.length ? Math.round(sum(durations) / durations.length) : 0,
        p95DurationMs: percentile(durations, 0.95),
        lastUsedAt: Math.max(...records.map((r) => r.ts)),
      };
    });

    const toolCounts = new Map<string, { calls: number; errors: number; total: number }>();
    for (const tool of this.tools.filter((t) => t.ts >= since)) {
      const entry = toolCounts.get(tool.tool) ?? { calls: 0, errors: 0, total: 0 };
      entry.calls += 1;
      if (tool.isError) entry.errors += 1;
      entry.total += tool.durationMs;
      toolCounts.set(tool.tool, entry);
    }

    const hourMs = 3_600_000;
    const nowHour = Math.floor(Date.now() / hourMs);
    const activity = Array.from({ length: 24 }, (_, index) => {
      const hour = nowHour - 23 + index;
      const inHour = runs.filter((run) => Math.floor(run.ts / hourMs) === hour);
      return {
        hour: hour * hourMs,
        runs: inHour.length,
        errors: inHour.filter((r) => r.status === 'error').length,
      };
    });

    return {
      since,
      runs: runs.length,
      errors: runs.filter((r) => r.status === 'error').length,
      aborted: runs.filter((r) => r.status === 'aborted').length,
      inputTokens: sum(runs.map((r) => r.inputTokens)),
      outputTokens: sum(runs.map((r) => r.outputTokens)),
      toolCalls: sum(runs.map((r) => r.toolCalls)),
      models: models.sort((a, b) => b.runs - a.runs),
      topTools: [...toolCounts.entries()]
        .map(([tool, entry]) => ({
          tool,
          calls: entry.calls,
          errors: entry.errors,
          averageDurationMs: Math.round(entry.total / entry.calls),
        }))
        .sort((a, b) => b.calls - a.calls)
        .slice(0, 10),
      activity,
    };
  }

  clear(): void {
    this.runs = [];
    this.tools = [];
  }

  async flush(): Promise<void> {
    await this.writeQueue.catch(() => undefined);
  }

  private append(file: string, record: unknown): void {
    this.writeQueue = this.writeQueue
      .then(async () => {
        await fsp.mkdir(this.dir, { recursive: true });
        await fsp.appendFile(path.join(this.dir, file), `${JSON.stringify(record)}\n`, 'utf8');
      })
      .catch(() => undefined);
  }
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index] ?? 0;
}
