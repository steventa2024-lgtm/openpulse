import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ExecApprovals, ExecDecision } from '../approvals/exec-approvals.js';
import { THINKING_LEVELS, type OpenPulseConfig, type ThinkingLevel } from '../config/schema.js';
import type { Logger } from '../infra/logger.js';
import { canonicalSessionKey, mainSessionKey } from '../sessions/keys.js';
import type { SessionStore } from '../sessions/store.js';
import { formatModelRef, parseModelRef } from './models.js';
import type { AgentEvent, AgentRunner, ChatEvent, RunParams, RunResult } from './runner.js';
import { isSilentReply } from './system-prompt.js';

export interface DispatchParams {
  sessionKey: string;
  message: string;
  source: RunParams['source'] & { to?: string; senderId?: string };
  /** Deliver the final reply back to the origin (channels). */
  deliver?: (text: string) => Promise<void>;
  idempotencyKey?: string;
  extraSystemPrompt?: string;
}

interface Lane {
  running?: { runId: string; controller: AbortController };
  queue: { params: DispatchParams; runId: string; resolve: (r: RunResult) => void }[];
}

const HELP = [
  'Commands:',
  '/new [model] — start a fresh session (optionally switching model)',
  '/reset — same as /new',
  '/stop — abort the current run',
  '/status — session, model and token usage',
  "/model [provider/model] — show or set this session's model",
  `/think <${THINKING_LEVELS.join('|')}> — reasoning depth for this session`,
  '/verbose on|off — show tool activity in chat',
  '/approve <id> allow-once|allow-always|deny — answer an exec approval',
  '/whoami — your sender id',
].join('\n');

/**
 * Serialises agent turns per session (followup queue), caps global concurrency, handles chat
 * commands and fans out streaming events for the gateway to broadcast.
 */
export class AgentService extends EventEmitter<{ chat: [ChatEvent]; agent: [AgentEvent] }> {
  private readonly lanes = new Map<string, Lane>();
  private readonly systemEvents = new Map<string, string[]>();
  private readonly idempotency = new Map<
    string,
    { runId: string; status: 'in_flight' | 'ok' | 'error'; at: number }
  >();
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(
    private readonly deps: {
      runner: AgentRunner;
      sessions: SessionStore;
      config: () => OpenPulseConfig;
      approvals: ExecApprovals;
      agentId: string;
      log: Logger;
    },
  ) {
    super();
    this.setMaxListeners(100);
  }

  get mainKey(): string {
    return mainSessionKey(this.deps.agentId, this.deps.config().session.mainKey);
  }

  canonical(key: string | undefined): string {
    return canonicalSessionKey(
      key ?? 'main',
      this.deps.agentId,
      this.deps.config().session.mainKey,
    );
  }

  /** Queue system text to prefix the session's next turn (cron main jobs, wake). */
  enqueueSystemEvent(sessionKey: string, text: string): void {
    const list = this.systemEvents.get(sessionKey) ?? [];
    list.push(text);
    this.systemEvents.set(sessionKey, list);
  }

  hasSystemEvents(sessionKey: string): boolean {
    return (this.systemEvents.get(sessionKey)?.length ?? 0) > 0;
  }

  activeRuns(): { sessionKey: string; runId: string }[] {
    return [...this.lanes.entries()]
      .filter(([, l]) => l.running)
      .map(([k, l]) => ({ sessionKey: k, runId: l.running!.runId }));
  }

  isBusy(sessionKey: string): boolean {
    const lane = this.lanes.get(sessionKey);
    return Boolean(lane?.running) || (lane?.queue.length ?? 0) > 0;
  }

  /**
   * Non-blocking send (chat.send / channel inbound). Returns immediately with a runId; the reply
   * streams via events and is delivered through `deliver`.
   */
  async dispatch(p: DispatchParams): Promise<{
    runId: string;
    status: 'started' | 'in_flight' | 'ok' | 'command' | 'error';
    reply?: string;
  }> {
    this.pruneIdempotency();
    if (p.idempotencyKey) {
      const seen = this.idempotency.get(p.idempotencyKey);
      if (seen) return { runId: seen.runId, status: seen.status };
    }

    const command = await this.handleCommand(p);
    if (command !== undefined) {
      if (p.deliver) await p.deliver(command);
      return { runId: '', status: 'command', reply: command };
    }

    const runId = randomUUID();
    if (p.idempotencyKey)
      this.idempotency.set(p.idempotencyKey, { runId, status: 'in_flight', at: Date.now() });
    void this.enqueue(p, runId).then(
      () => {
        if (p.idempotencyKey)
          this.idempotency.set(p.idempotencyKey, { runId, status: 'ok', at: Date.now() });
      },
      // A dispatched run reports its own failure through chat events; this keeps a rejection
      // here from surfacing as an unhandled rejection and taking the process down.
      (error: unknown) => {
        this.deps.log.warn(`run ${runId} failed: ${(error as Error).message}`);
        if (p.idempotencyKey)
          this.idempotency.set(p.idempotencyKey, { runId, status: 'error', at: Date.now() });
      },
    );
    return { runId, status: 'started' };
  }

  /** Run a turn and wait for its result (heartbeat, cron isolated, sessions_send). */
  runAndWait(p: DispatchParams, runId: string = randomUUID()): Promise<RunResult> {
    return this.enqueue(p, runId);
  }

  abort(sessionKey: string, opts: { runId?: string; clearQueue?: boolean } = {}): boolean {
    const lane = this.lanes.get(sessionKey);
    if (!lane) return false;
    if (opts.clearQueue !== false) lane.queue.splice(0);
    if (lane.running && (!opts.runId || lane.running.runId === opts.runId)) {
      lane.running.controller.abort();
      return true;
    }
    return false;
  }

  abortAll(): void {
    for (const key of this.lanes.keys()) this.abort(key);
  }

  private enqueue(params: DispatchParams, runId: string): Promise<RunResult> {
    const key = params.sessionKey;
    const lane = this.lanes.get(key) ?? { queue: [] };
    this.lanes.set(key, lane);
    return new Promise((resolve) => {
      lane.queue.push({ params, runId, resolve });
      if (!lane.running) void this.drain(key);
    });
  }

  private async drain(key: string): Promise<void> {
    const lane = this.lanes.get(key);
    if (!lane || lane.running) return;
    const next = lane.queue.shift();
    if (!next) {
      this.lanes.delete(key);
      return;
    }
    const controller = new AbortController();
    lane.running = { runId: next.runId, controller };
    await this.acquire();
    try {
      next.resolve(await this.execute(next.params, next.runId, controller.signal));
    } finally {
      this.release();
      lane.running = undefined;
      void this.drain(key).catch((error: unknown) =>
        this.deps.log.warn(`session lane ${key} stopped: ${(error as Error).message}`),
      );
    }
  }

  private async execute(p: DispatchParams, runId: string, signal: AbortSignal): Promise<RunResult> {
    await this.applyResetPolicy(p.sessionKey);
    const events = this.systemEvents.get(p.sessionKey);
    let message = p.message;
    if (events?.length) {
      this.systemEvents.delete(p.sessionKey);
      message = `${events.map((e) => `System: ${e}`).join('\n')}\n\n${message}`;
    }
    const result = await this.deps.runner.run({
      runId,
      sessionKey: p.sessionKey,
      message,
      source: p.source,
      signal,
      onAgentEvent: (e) => this.emit('agent', e),
      onChatEvent: (e) => this.emit('chat', e),
      ...(p.extraSystemPrompt !== undefined && { extraSystemPrompt: p.extraSystemPrompt }),
    });

    if (p.source.channel && p.source.to && p.source.kind === 'user') {
      await this.deps.sessions
        .patch(p.sessionKey, {
          lastChannel: p.source.channel,
          lastTo: p.source.to,
          lastInteractionAt: Date.now(),
        })
        .catch(() => undefined);
    }
    if (p.deliver && !result.aborted) {
      const text = result.error ? `⚠️ ${result.error}` : result.text;
      if (text && !isSilentReply(text)) {
        await p
          .deliver(text)
          .catch((e: unknown) => this.deps.log.error(`delivery failed: ${(e as Error).message}`));
      }
    }
    return result;
  }

  private async applyResetPolicy(key: string): Promise<void> {
    const entry = await this.deps.sessions.get(key);
    if (!entry) return;
    const policy = this.deps.config().session.reset;
    const now = new Date();
    let stale = false;
    if (policy.mode === 'idle') {
      stale =
        now.getTime() - (entry.lastInteractionAt ?? entry.updatedAt) > policy.idleMinutes * 60_000;
    } else if (policy.mode === 'daily') {
      const boundary = new Date(now);
      boundary.setHours(policy.atHour, 0, 0, 0);
      if (boundary > now) boundary.setDate(boundary.getDate() - 1);
      stale = entry.createdAt < boundary.getTime();
    }
    if (stale) {
      this.deps.log.info(`session ${key} reset by ${policy.mode} policy`);
      await this.deps.sessions.reset(key);
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.deps.config().agents.defaults.maxConcurrent) {
      this.active++;
      return;
    }
    await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
  }

  private release(): void {
    this.active--;
    this.waiters.shift()?.();
  }

  private pruneIdempotency(): void {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [k, v] of this.idempotency) if (v.at < cutoff) this.idempotency.delete(k);
  }

  /** Returns the reply text if the message was a chat command. */
  private async handleCommand(p: DispatchParams): Promise<string | undefined> {
    const text = p.message.trim();
    const m = /^\/([a-z]+)(?:@\S+)?(?:\s+([\s\S]*))?$/i.exec(text);
    if (!m) {
      if (/^(stop|stop run|stop action|please stop)$/i.test(text) && this.isBusy(p.sessionKey)) {
        this.abort(p.sessionKey);
        return '⏹️ Stopped.';
      }
      return undefined;
    }
    const cmd = m[1]!.toLowerCase();
    const arg = (m[2] ?? '').trim();
    const { sessions } = this.deps;
    const config = this.deps.config();

    switch (cmd) {
      case 'help':
      case 'start':
        return HELP;
      case 'new':
      case 'reset': {
        this.abort(p.sessionKey);
        await sessions.reset(p.sessionKey);
        if (arg)
          await sessions.patch(p.sessionKey, {
            modelOverride: formatModelRef(parseModelRef(arg, config)),
          });
        return `🆕 New session started${arg ? ` with ${formatModelRef(parseModelRef(arg, config))}` : ''}.`;
      }
      case 'stop':
        return this.abort(p.sessionKey) ? '⏹️ Stopped.' : 'Nothing is running.';
      case 'status': {
        const e = await sessions.ensure(p.sessionKey);
        const model = e.modelOverride ?? config.agents.defaults.model.primary;
        return [
          `🦾 OpenPulse status`,
          `Session: ${p.sessionKey}`,
          `Model: ${model}${e.modelOverride ? ' (session override)' : ''}`,
          `Thinking: ${e.thinkingLevel ?? config.agents.defaults.thinkingDefault}`,
          `Tokens: ${e.inputTokens.toLocaleString()} in / ${e.outputTokens.toLocaleString()} out · context ${e.contextTokens?.toLocaleString() ?? '—'}`,
          `Running: ${this.isBusy(p.sessionKey) ? 'yes' : 'no'}`,
        ].join('\n');
      }
      case 'model': {
        const e = await sessions.ensure(p.sessionKey);
        if (!arg) return `Model: ${e.modelOverride ?? config.agents.defaults.model.primary}`;
        const catalog = Object.keys(config.agents.defaults.models);
        const ref = formatModelRef(parseModelRef(arg, config));
        if (catalog.length > 0 && !catalog.includes(ref))
          return `Model ${ref} is not in agents.defaults.models (allowed: ${catalog.join(', ')}).`;
        await sessions.patch(p.sessionKey, {
          modelOverride: arg === 'default' ? null : ref,
        } as never);
        return arg === 'default'
          ? 'Model reset to default.'
          : `Model set to ${ref} for this session.`;
      }
      case 'think':
      case 'thinking': {
        await sessions.ensure(p.sessionKey);
        if (!(THINKING_LEVELS as readonly string[]).includes(arg))
          return `Usage: /think <${THINKING_LEVELS.join('|')}>`;
        await sessions.patch(p.sessionKey, { thinkingLevel: arg as ThinkingLevel });
        return `Thinking level: ${arg}.`;
      }
      case 'verbose': {
        await sessions.ensure(p.sessionKey);
        if (arg !== 'on' && arg !== 'off') return 'Usage: /verbose on|off';
        await sessions.patch(p.sessionKey, { verboseLevel: arg });
        return `Verbose ${arg}.`;
      }
      case 'whoami':
        return `You are ${p.source.senderName ?? 'unknown'} (${p.source.channel ?? 'webchat'}:${p.source.senderId ?? p.source.to ?? '—'}).`;
      case 'approve': {
        const [id, decisionRaw] = arg.split(/\s+/);
        const decision = (decisionRaw ?? 'allow-once').toLowerCase();
        if (
          !id ||
          !['allow-once', 'allow-always', 'deny', 'allow', 'always', 'no'].includes(decision)
        ) {
          return 'Usage: /approve <id> allow-once|allow-always|deny';
        }
        const d: ExecDecision =
          decision === 'allow'
            ? 'allow-once'
            : decision === 'always'
              ? 'allow-always'
              : decision === 'no'
                ? 'deny'
                : (decision as ExecDecision);
        const by = `${p.source.channel ?? 'chat'}:${p.source.senderId ?? p.source.senderName ?? 'user'}`;
        return this.deps.approvals.resolve(id, d, by)
          ? `✅ ${d} (${id}).`
          : `No pending approval ${id}.`;
      }
      default:
        return undefined; // unknown /text goes to the model
    }
  }
}
