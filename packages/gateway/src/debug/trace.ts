import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AgentEvent } from '../agent/runner.js';
import { sanitizeText, sanitizeValue } from './sanitize.js';

export type TraceKind =
  | 'run.start'
  | 'run.end'
  | 'run.error'
  | 'model.fallback'
  | 'thinking'
  | 'assistant'
  | 'tool.start'
  | 'tool.result'
  | 'approval';

export interface TraceEvent {
  ts: number;
  kind: TraceKind;
  /** Human summary, e.g. "exec: git status". */
  label: string;
  toolCallId?: string;
  tool?: string;
  durationMs?: number;
  isError?: boolean;
  /** Sanitized details: tool input, tool output, error text, usage. */
  data?: Record<string, unknown>;
}

export interface RunTrace {
  runId: string;
  sessionKey: string;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'ok' | 'error' | 'aborted';
  model?: string;
  toolCalls: number;
  errors: number;
  usage?: { input: number; output: number; total?: number };
  error?: string;
  events: TraceEvent[];
}

const MAX_RUNS = 200;
const MAX_EVENTS_PER_RUN = 2_000;
const MAX_FIELD_CHARS = 8_000;

/**
 * Builds an execution timeline for each agent run from the events the runner already emits.
 *
 * Nothing here is reconstructed after the fact: every entry is an event the runtime produced while
 * the run happened. Text is sanitized on the way in, so a trace can be shown or exported without
 * leaking the API keys, tokens or passwords that passed through a tool.
 */
export class TraceRecorder {
  private readonly runs = new Map<string, RunTrace>();
  /** Assistant text arrives as many deltas; they are folded into one event per step. */
  private readonly assistantBuffers = new Map<string, TraceEvent>();
  private readonly thinkingBuffers = new Map<string, TraceEvent>();

  constructor(private readonly options: { secrets?: () => string[]; dir?: string } = {}) {}

  /**
   * Read back the most recent finished runs written by earlier gateway processes, so the debugger
   * keeps its history across restarts. Unreadable lines are skipped.
   */
  async load(): Promise<void> {
    if (!this.options.dir) return;
    let files: string[];
    try {
      files = (await fsp.readdir(this.options.dir)).filter((f) =>
        /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f),
      );
    } catch {
      return;
    }
    const loaded: RunTrace[] = [];
    for (const file of files.sort().reverse()) {
      let text: string;
      try {
        text = await fsp.readFile(path.join(this.options.dir, file), 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n').reverse()) {
        if (!line.trim()) continue;
        try {
          const trace = JSON.parse(line) as RunTrace;
          if (!trace.runId || !Array.isArray(trace.events)) continue;
          // Older traces stored zero counts from providers that reported nothing.
          if (trace.usage && trace.usage.input + trace.usage.output === 0) delete trace.usage;
          loaded.push(trace);
        } catch {
          // A torn last line from a crash; the rest of the file is still good.
        }
        if (loaded.length >= MAX_RUNS) break;
      }
      if (loaded.length >= MAX_RUNS) break;
    }
    for (const trace of loaded.sort((a, b) => a.startedAt - b.startedAt)) {
      if (!this.runs.has(trace.runId)) this.runs.set(trace.runId, trace);
    }
  }

  record(event: AgentEvent): void {
    const trace = this.ensure(event);
    const secrets = this.options.secrets?.() ?? [];
    const data = event.data;

    if (event.stream === 'lifecycle') {
      const phase = data.phase as string | undefined;
      if (phase === 'start') {
        trace.model = typeof data.model === 'string' ? data.model : trace.model;
        this.push(trace, {
          ts: event.ts,
          kind: 'run.start',
          label: `Run started${trace.model ? ` on ${trace.model}` : ''}`,
          data: sanitizeValue(data, secrets) as Record<string, unknown>,
        });
        return;
      }
      if (phase === 'fallback') {
        this.flushBuffers(trace);
        trace.errors += 1;
        trace.model = typeof data.to === 'string' ? data.to : trace.model;
        this.push(trace, {
          ts: event.ts,
          kind: 'model.fallback',
          label: `${str(data.from, 'Model')} failed; switched to ${str(data.to, 'a fallback')}`,
          isError: true,
          data: sanitizeValue(data, secrets) as Record<string, unknown>,
        });
        return;
      }
      if (phase === 'end') {
        trace.endedAt = event.ts;
        trace.status = data.aborted ? 'aborted' : 'ok';
        const usage = data.usage as RunTrace['usage'];
        // A provider that reports nothing leaves both counts at zero: show that as unreported.
        if (usage && usage.input + usage.output > 0) trace.usage = usage;
        this.flushBuffers(trace);
        this.push(trace, {
          ts: event.ts,
          kind: 'run.end',
          label: data.aborted ? `Run stopped (${str(data.reason, 'aborted')})` : 'Run finished',
          durationMs: event.ts - trace.startedAt,
          data: sanitizeValue(data, secrets) as Record<string, unknown>,
        });
        void this.persist(trace);
        return;
      }
      if (phase === 'error') {
        trace.endedAt = event.ts;
        trace.status = 'error';
        trace.errors += 1;
        trace.error = sanitizeText(str(data.error, 'unknown error'), secrets);
        this.flushBuffers(trace);
        this.push(trace, {
          ts: event.ts,
          kind: 'run.error',
          label: 'Run failed',
          isError: true,
          data: { error: trace.error },
        });
        void this.persist(trace);
      }
      return;
    }

    if (event.stream === 'assistant' || event.stream === 'thinking') {
      const buffers = event.stream === 'assistant' ? this.assistantBuffers : this.thinkingBuffers;
      const delta = typeof data.delta === 'string' ? data.delta : '';
      const current = buffers.get(trace.runId);
      if (current) {
        const text = `${str(current.data?.text, '')}${delta}`;
        current.data = { text: clip(text) };
        return;
      }
      const entry: TraceEvent = {
        ts: event.ts,
        kind: event.stream === 'assistant' ? 'assistant' : 'thinking',
        label: event.stream === 'assistant' ? 'Model output' : 'Model reasoning',
        data: { text: delta },
      };
      buffers.set(trace.runId, entry);
      this.push(trace, entry);
      return;
    }

    if (event.stream === 'tool') {
      // A tool call ends the current text step.
      this.flushBuffers(trace);
      const name = str(data.name, 'tool');
      if (data.phase === 'start') {
        trace.toolCalls += 1;
        this.push(trace, {
          ts: event.ts,
          kind: 'tool.start',
          label: sanitizeText(str(data.summary, name), secrets),
          tool: name,
          toolCallId: str(data.toolCallId, ''),
          data: { input: sanitizeValue(data.args, secrets) },
        });
        return;
      }
      const isError = Boolean(data.isError);
      if (isError) trace.errors += 1;
      this.push(trace, {
        ts: event.ts,
        kind: 'tool.result',
        label: `${name} ${isError ? 'failed' : 'returned'}`,
        tool: name,
        toolCallId: str(data.toolCallId, ''),
        ...(typeof data.durationMs === 'number' && { durationMs: data.durationMs }),
        isError,
        data: { output: clip(sanitizeText(str(data.result, ''), secrets)) },
      });
    }
  }

  /** Note an approval decision inside the run that asked for it. */
  recordApproval(
    runKey: { sessionKey: string },
    entry: { command: string; decision: string; by: string },
  ): void {
    const trace = [...this.runs.values()]
      .reverse()
      .find((t) => t.sessionKey === runKey.sessionKey && t.status === 'running');
    if (!trace) return;
    const secrets = this.options.secrets?.() ?? [];
    this.push(trace, {
      ts: Date.now(),
      kind: 'approval',
      label: `Approval ${entry.decision}`,
      data: {
        command: sanitizeText(entry.command, secrets),
        decision: entry.decision,
        by: entry.by,
      },
    });
  }

  list(
    filter: { sessionKey?: string; status?: RunTrace['status']; limit?: number } = {},
  ): Omit<RunTrace, 'events'>[] {
    return [...this.runs.values()]
      .filter((trace) => !filter.sessionKey || trace.sessionKey === filter.sessionKey)
      .filter((trace) => !filter.status || trace.status === filter.status)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, filter.limit ?? 50)
      .map(
        ({ events: _events, ...rest }) =>
          ({ ...rest, eventCount: _events.length }) as Omit<RunTrace, 'events'>,
      );
  }

  get(runId: string): RunTrace | undefined {
    return this.runs.get(runId);
  }

  /** A self-contained, sanitized document describing one run or a whole session. */
  export(filter: { runId?: string; sessionKey?: string }): {
    exportedAt: string;
    runs: RunTrace[];
  } {
    const runs = filter.runId
      ? [this.runs.get(filter.runId)].filter((t): t is RunTrace => Boolean(t))
      : [...this.runs.values()].filter(
          (t) => !filter.sessionKey || t.sessionKey === filter.sessionKey,
        );
    return { exportedAt: new Date().toISOString(), runs: runs.map((run) => structuredClone(run)) };
  }

  private ensure(event: AgentEvent): RunTrace {
    let trace = this.runs.get(event.runId);
    if (!trace) {
      trace = {
        runId: event.runId,
        sessionKey: event.sessionKey,
        startedAt: event.ts,
        status: 'running',
        toolCalls: 0,
        errors: 0,
        events: [],
      };
      this.runs.set(event.runId, trace);
      if (this.runs.size > MAX_RUNS) {
        const oldest = [...this.runs.values()].sort((a, b) => a.startedAt - b.startedAt)[0];
        if (oldest) this.runs.delete(oldest.runId);
      }
    }
    return trace;
  }

  private push(trace: RunTrace, event: TraceEvent): void {
    if (trace.events.length >= MAX_EVENTS_PER_RUN) return;
    trace.events.push(event);
  }

  private flushBuffers(trace: RunTrace): void {
    const secrets = this.options.secrets?.() ?? [];
    for (const buffers of [this.assistantBuffers, this.thinkingBuffers]) {
      const entry = buffers.get(trace.runId);
      if (entry?.data?.text) entry.data.text = sanitizeText(str(entry.data.text, ''), secrets);
      buffers.delete(trace.runId);
    }
  }

  private async persist(trace: RunTrace): Promise<void> {
    if (!this.options.dir) return;
    try {
      await fsp.mkdir(this.options.dir, { recursive: true });
      const file = path.join(
        this.options.dir,
        `${new Date(trace.startedAt).toISOString().slice(0, 10)}.jsonl`,
      );
      await fsp.appendFile(file, `${JSON.stringify(trace)}\n`, 'utf8');
    } catch {
      // A trace that cannot be written is not worth failing a run over.
    }
  }
}

function clip(text: string): string {
  return text.length > MAX_FIELD_CHARS
    ? `${text.slice(0, MAX_FIELD_CHARS)}… [${text.length - MAX_FIELD_CHARS} more characters]`
    : text;
}

/** A field from an event payload as text; non-strings fall back rather than printing [object Object]. */
function str(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}
