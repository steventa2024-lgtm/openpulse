import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Cron } from 'croner';
import type { AgentService } from '../agent/agent-service.js';
import { isSilentReply, stripHeartbeatToken } from '../agent/system-prompt.js';
import type { OpenPulseConfig } from '../config/schema.js';
import type { Logger } from '../infra/logger.js';
import { cronSessionKey } from '../sessions/keys.js';
import type { SessionStore } from '../sessions/store.js';
import { KeyedMutex, readTextOr, writeFileAtomic } from '../util/fs.js';
import { CronJobInputSchema, type CronJob, type CronRunRecord } from './types.js';

export interface CronEvent {
  jobId: string;
  action: 'added' | 'updated' | 'removed' | 'started' | 'finished';
  status?: CronRunRecord['status'];
  nextRunAtMs?: number;
  error?: string;
  summary?: string;
}

export interface CronDeps {
  dir: string;
  config: () => OpenPulseConfig;
  agent: AgentService;
  sessions: SessionStore;
  deliver: (channel: string, to: string, text: string) => Promise<void>;
  wakeHeartbeat: (reason: string) => void;
  log: Logger;
  now?: () => number;
}

const MAX_TIMER_MS = 60_000;

/** The gateway scheduler: persists jobs, wakes on time, runs them and records history. */
export class CronService extends EventEmitter<{ cron: [CronEvent] }> {
  private jobs: CronJob[] = [];
  private timer: NodeJS.Timeout | undefined;
  private running = new Set<string>();
  /** Scheduler ticks in progress, so shutdown can wait for their results to be saved. */
  private ticks = new Set<Promise<void>>();
  private started = false;
  private readonly lock = new KeyedMutex();
  private readonly now: () => number;

  constructor(private readonly deps: CronDeps) {
    super();
    this.now = deps.now ?? Date.now;
  }

  get storePath(): string {
    return path.join(this.deps.dir, 'jobs.json');
  }

  async start(): Promise<void> {
    await this.load();
    this.started = true;
    for (const j of this.jobs) j.state.nextRunAtMs = this.computeNext(j);
    await this.save();
    this.arm();
  }

  stop(): void {
    this.started = false;
    clearTimeout(this.timer);
  }

  /** Resolves once jobs the scheduler started have finished and their state is saved. */
  async idle(): Promise<void> {
    while (this.ticks.size > 0) await Promise.allSettled([...this.ticks]);
  }

  status() {
    const enabled = this.deps.config().cron.enabled && process.env.OPENPULSE_SKIP_CRON !== '1';
    const next = this.jobs
      .filter((j) => j.enabled && j.state.nextRunAtMs)
      .map((j) => j.state.nextRunAtMs!);
    return {
      enabled,
      jobs: this.jobs.length,
      nextWakeAtMs: next.length ? Math.min(...next) : null,
      storePath: this.storePath,
    };
  }

  list(includeDisabled = true): CronJob[] {
    return this.jobs
      .filter((j) => includeDisabled || j.enabled)
      .sort((a, b) => (a.state.nextRunAtMs ?? Infinity) - (b.state.nextRunAtMs ?? Infinity));
  }

  get(jobId: string): CronJob | undefined {
    return this.jobs.find((j) => j.jobId === jobId);
  }

  async add(input: unknown): Promise<CronJob> {
    const parsed = CronJobInputSchema.parse(normalizeInput(input));
    const now = this.now();
    const job: CronJob = {
      ...parsed,
      deleteAfterRun: parsed.deleteAfterRun ?? parsed.schedule.kind === 'at',
      jobId: randomBytes(4).toString('hex'),
      createdAtMs: now,
      updatedAtMs: now,
      state: {},
    };
    job.state.nextRunAtMs = this.computeNext(job);
    this.jobs.push(job);
    await this.save();
    this.emit('cron', {
      jobId: job.jobId,
      action: 'added',
      ...(job.state.nextRunAtMs && { nextRunAtMs: job.state.nextRunAtMs }),
    });
    this.arm();
    return job;
  }

  async update(jobId: string, patch: unknown): Promise<CronJob> {
    const job = this.require(jobId);
    const { jobId: _i, createdAtMs: _c, updatedAtMs: _u, state: _s, ...current } = job;
    const merged = CronJobInputSchema.parse({ ...current, ...normalizeInput(patch) });
    Object.assign(job, merged, { updatedAtMs: this.now() });
    job.state.nextRunAtMs = this.computeNext(job);
    await this.save();
    this.emit('cron', {
      jobId,
      action: 'updated',
      ...(job.state.nextRunAtMs && { nextRunAtMs: job.state.nextRunAtMs }),
    });
    this.arm();
    return job;
  }

  async remove(jobId: string): Promise<{ removed: boolean }> {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((j) => j.jobId !== jobId);
    await this.save();
    if (before !== this.jobs.length) this.emit('cron', { jobId, action: 'removed' });
    this.arm();
    return { removed: before !== this.jobs.length };
  }

  /** Run now (force) regardless of schedule. */
  async run(jobId: string): Promise<CronRunRecord> {
    return this.execute(this.require(jobId));
  }

  async runs(jobId: string, limit = 50): Promise<CronRunRecord[]> {
    const text = await readTextOr(this.runsFile(jobId), '');
    return text
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as CronRunRecord)
      .slice(-limit)
      .reverse();
  }

  /** Queue a system event for the main session and optionally wake the heartbeat. */
  wake(text: string, mode: 'now' | 'next-heartbeat'): { ok: true } {
    this.deps.agent.enqueueSystemEvent(this.deps.agent.mainKey, text);
    if (mode === 'now') this.deps.wakeHeartbeat('wake');
    return { ok: true };
  }

  private require(jobId: string): CronJob {
    const job = this.get(jobId);
    if (!job) throw new Error(`Unknown cron job "${jobId}"`);
    return job;
  }

  private arm(): void {
    clearTimeout(this.timer);
    if (!this.started || !this.status().enabled) return;
    const next = this.jobs
      .filter((j) => j.enabled && j.state.nextRunAtMs && !this.running.has(j.jobId))
      .map((j) => j.state.nextRunAtMs!);
    if (next.length === 0) return;
    const delay = Math.max(0, Math.min(Math.min(...next) - this.now(), MAX_TIMER_MS));
    this.timer = setTimeout(() => {
      const tick = this.tick().catch((error: unknown) =>
        this.deps.log.error(`cron tick failed: ${(error as Error).message}`),
      );
      this.ticks.add(tick);
      void tick.finally(() => this.ticks.delete(tick));
    }, delay);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    const now = this.now();
    const due = this.jobs.filter(
      (j) =>
        j.enabled &&
        j.state.nextRunAtMs !== undefined &&
        j.state.nextRunAtMs <= now &&
        !this.running.has(j.jobId),
    );
    const slots = this.deps.config().cron.maxConcurrentRuns - this.running.size;
    await Promise.all(due.slice(0, Math.max(0, slots)).map((j) => this.execute(j)));
    this.arm();
  }

  private async execute(job: CronJob): Promise<CronRunRecord> {
    const started = this.now();
    this.running.add(job.jobId);
    job.state.runningAtMs = started;
    this.emit('cron', { jobId: job.jobId, action: 'started' });
    this.deps.log.info(`cron run: ${job.name}`, { jobId: job.jobId, target: job.sessionTarget });

    let status: CronRunRecord['status'] = 'ok';
    let error: string | undefined;
    let summary: string | undefined;
    let delivered = false;
    try {
      if (job.payload.kind === 'systemEvent') {
        this.deps.agent.enqueueSystemEvent(this.deps.agent.mainKey, job.payload.text);
        if (job.wakeMode === 'now') this.deps.wakeHeartbeat(`cron:${job.jobId}`);
        summary = job.payload.text;
        if (job.delivery?.mode === 'webhook')
          delivered = await this.postWebhook(job, { status, summary });
      } else {
        const key = cronSessionKey(job.jobId, job.agentId);
        await this.deps.sessions.ensure(key, { displayName: `cron: ${job.name}` });
        await this.deps.sessions.reset(key); // fresh session per run
        if (job.payload.model)
          await this.deps.sessions.patch(key, { modelOverride: job.payload.model });
        if (job.payload.thinking)
          await this.deps.sessions.patch(key, { thinkingLevel: job.payload.thinking });
        const result = await this.deps.agent.runAndWait({
          sessionKey: key,
          message: `[cron:${job.jobId} ${job.name}] ${job.payload.message}`,
          source: { kind: 'cron', channel: 'cron' },
        });
        if (result.error) throw new Error(result.error);
        const stripped = stripHeartbeatToken(result.text, 0);
        summary = stripped.ok || isSilentReply(result.text) ? '' : stripped.text;
        delivered = await this.deliver(job, summary);
      }
    } catch (e) {
      status = 'error';
      error = (e as Error).message;
      this.deps.log.error(`cron job ${job.name} failed: ${error}`);
    } finally {
      this.running.delete(job.jobId);
    }

    const durationMs = this.now() - started;
    delete job.state.runningAtMs;
    job.state.lastRunAtMs = started;
    job.state.lastStatus = status;
    job.state.lastDurationMs = durationMs;
    if (error) job.state.lastError = error;
    else delete job.state.lastError;

    if (job.schedule.kind === 'at' && status === 'ok') {
      if (job.deleteAfterRun) await this.remove(job.jobId);
      else job.enabled = false;
    }
    job.state.nextRunAtMs = this.computeNext(job);
    await this.save();

    const record: CronRunRecord = {
      ts: this.now(),
      jobId: job.jobId,
      action: 'finished',
      status,
      runAtMs: started,
      durationMs,
      delivered,
      ...(error && { error }),
      ...(summary && { summary: summary.slice(0, 2000) }),
      ...(job.state.nextRunAtMs && { nextRunAtMs: job.state.nextRunAtMs }),
    };
    // History is best-effort: a failed write must not break the job that just finished.
    await this.appendRun(record).catch((e: unknown) => {
      this.deps.log.warn(`cron: could not record run for ${job.jobId}: ${(e as Error).message}`);
    });
    this.emit('cron', {
      jobId: job.jobId,
      action: 'finished',
      status,
      ...(error && { error }),
      ...(summary && { summary: summary.slice(0, 500) }),
    });
    return record;
  }

  private async deliver(job: CronJob, summary: string): Promise<boolean> {
    const mode = job.delivery?.mode ?? 'announce';
    if (mode === 'none' || !summary) return false;
    if (mode === 'webhook') return this.postWebhook(job, { status: 'ok', summary });

    let channel = job.delivery?.channel;
    let to = job.delivery?.to;
    if (!channel || channel === 'last' || !to) {
      const main = await this.deps.sessions.get(this.deps.agent.mainKey);
      if (!channel || channel === 'last') channel = main?.lastChannel;
      to ??= main?.lastTo;
    }
    // Brief summary into the main session so the agent knows what happened.
    this.deps.agent.enqueueSystemEvent(
      this.deps.agent.mainKey,
      `Cron job "${job.name}" finished: ${summary.slice(0, 500)}`,
    );
    if (job.wakeMode === 'now') this.deps.wakeHeartbeat(`cron:${job.jobId}`);
    if (!channel || !to) {
      if (job.delivery?.bestEffort) return false;
      throw new Error(
        'announce delivery has no target (set delivery.channel/to or chat with the agent first)',
      );
    }
    try {
      await this.deps.deliver(channel, to, summary);
      return true;
    } catch (e) {
      if (job.delivery?.bestEffort) return false;
      throw e;
    }
  }

  private async postWebhook(
    job: CronJob,
    body: { status: string; summary?: string },
  ): Promise<boolean> {
    const url = job.delivery?.to;
    if (!url || !/^https?:\/\//.test(url))
      throw new Error('webhook delivery needs delivery.to = http(s) URL');
    const token = this.deps.config().cron.webhookToken;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token && { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({
        event: 'cron.finished',
        jobId: job.jobId,
        name: job.name,
        ...body,
        ts: this.now(),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
    return true;
  }

  computeNext(job: CronJob): number | undefined {
    if (!job.enabled) return undefined;
    const now = this.now();
    const s = job.schedule;
    if (s.kind === 'at') {
      const at = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s.at) ? s.at : `${s.at}Z`);
      if (Number.isNaN(at)) return undefined;
      return job.state.lastRunAtMs && job.state.lastStatus === 'ok' ? undefined : at;
    }
    if (s.kind === 'every') {
      const anchor = s.anchorMs ?? job.createdAtMs;
      const n = Math.max(1, Math.ceil((now - anchor) / s.everyMs));
      return anchor + n * s.everyMs;
    }
    const tz = s.tz ?? this.deps.config().agents.defaults.userTimezone;
    const next = new Cron(s.expr, { ...(tz && { timezone: tz }), paused: true }).nextRun(
      new Date(now),
    );
    return next?.getTime();
  }

  private async load(): Promise<void> {
    const text = await readTextOr(this.storePath, '');
    try {
      this.jobs = text ? ((JSON.parse(text) as { jobs?: CronJob[] }).jobs ?? []) : [];
    } catch {
      this.jobs = [];
    }
  }

  private async save(): Promise<void> {
    await this.lock.run('store', () =>
      writeFileAtomic(
        this.storePath,
        `${JSON.stringify({ version: 1, jobs: this.jobs }, null, 2)}\n`,
      ),
    );
  }

  private runsFile(jobId: string): string {
    return path.join(this.deps.dir, 'runs', `${jobId}.jsonl`);
  }

  private async appendRun(record: CronRunRecord): Promise<void> {
    const file = this.runsFile(record.jobId);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
    const lines = (await fsp.readFile(file, 'utf8')).split('\n').filter(Boolean);
    if (lines.length > 2000) await writeFileAtomic(file, `${lines.slice(-2000).join('\n')}\n`);
  }
}

/** Accept a few convenient shorthands (CLI/tool): at "20m", every "1h". */
function normalizeInput(input: unknown): Record<string, unknown> {
  const i = { ...((input ?? {}) as Record<string, unknown>) };
  const s = i.schedule as Record<string, unknown> | undefined;
  if (s?.kind === 'at' && typeof s.at === 'string' && /^\d+\s*(s|m|h|d)$/.test(s.at.trim())) {
    const m = /^(\d+)\s*(s|m|h|d)$/.exec(s.at.trim())!;
    const ms = Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's'];
    i.schedule = { kind: 'at', at: new Date(Date.now() + ms).toISOString() };
  }
  if (s?.kind === 'every' && typeof s.every === 'string') {
    const m = /^(\d+)\s*(s|m|h|d)$/.exec(s.every.trim());
    if (m)
      i.schedule = {
        kind: 'every',
        everyMs: Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's'],
      };
  }
  return i;
}
