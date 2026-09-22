import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { assessShellCommand } from '../policy/risk.js';
import type { RiskAssessment } from '../tools/types.js';
import { readTextOr, writeFileAtomic } from '../util/fs.js';

export const EXEC_SECURITY = ['deny', 'allowlist', 'full'] as const;
export const EXEC_ASK = ['off', 'on-miss', 'always'] as const;
export type ExecDecision = 'allow-once' | 'allow-always' | 'deny';

const AllowEntry = z.object({
  id: z.string(),
  pattern: z.string(),
  lastUsedAt: z.number().optional(),
  lastUsedCommand: z.string().optional(),
});

export const ExecApprovalsSchema = z.object({
  version: z.literal(1).default(1),
  defaults: z
    .object({
      security: z.enum(EXEC_SECURITY).default('allowlist'),
      ask: z.enum(EXEC_ASK).default('on-miss'),
      askFallback: z.enum(['deny', 'allowlist', 'full']).default('deny'),
      /** Treat read-only commands (ls, cat, git status…) as allowlisted. */
      autoAllowSafe: z.boolean().default(true),
      timeoutSeconds: z.number().int().min(10).max(3600).default(300),
    })
    .prefault({}),
  agents: z
    .record(z.string(), z.object({ allowlist: z.array(AllowEntry).default([]) }))
    .default({}),
});

export type ExecApprovalsFile = z.output<typeof ExecApprovalsSchema>;

export interface ExecApprovalRequest {
  id: string;
  request: {
    command: string;
    cwd: string;
    host: 'gateway';
    agentId: string;
    sessionKey: string;
    risk: RiskAssessment;
  };
  createdAtMs: number;
  expiresAtMs: number;
}

export interface ExecApprovalResolved {
  id: string;
  decision: ExecDecision | 'timeout';
  resolvedBy: string;
  ts: number;
  request: ExecApprovalRequest['request'];
}

export type ExecGate =
  | { action: 'allow'; reason: string; matched?: string }
  | { action: 'deny'; reason: string }
  | { action: 'ask'; reason: string };

/**
 * Host exec guardrail: policy + per-agent allowlist + human approvals. The agent's exec tool
 * calls `evaluate()`; "ask" outcomes go through `request()` which pauses until a decision
 * arrives from a chat (/approve), the Control UI, or the CLI.
 */
export class ExecApprovals extends EventEmitter<{
  requested: [ExecApprovalRequest];
  resolved: [ExecApprovalResolved];
}> {
  private data: ExecApprovalsFile | undefined;
  private readonly pending = new Map<
    string,
    { req: ExecApprovalRequest; settle: (d: ExecDecision | 'timeout', by: string) => void }
  >();

  constructor(readonly file: string) {
    super();
    this.setMaxListeners(50);
  }

  async load(): Promise<ExecApprovalsFile> {
    const text = await readTextOr(this.file, '');
    let raw: unknown;
    try {
      raw = text.trim() ? JSON.parse(text) : {};
    } catch {
      raw = {};
    }
    const parsed = ExecApprovalsSchema.safeParse(raw);
    this.data = parsed.success ? parsed.data : ExecApprovalsSchema.parse({});
    return this.data;
  }

  get(): ExecApprovalsFile {
    if (!this.data) throw new Error('ExecApprovals.load() has not been called');
    return this.data;
  }

  async set(next: unknown): Promise<ExecApprovalsFile> {
    const parsed = ExecApprovalsSchema.parse(next);
    this.data = parsed;
    await writeFileAtomic(this.file, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
    return parsed;
  }

  async addAllow(agentId: string, pattern: string): Promise<ExecApprovalsFile> {
    const data = structuredClone(this.get());
    const list = (data.agents[agentId] ??= { allowlist: [] }).allowlist;
    if (!list.some((e) => e.pattern === pattern)) {
      list.push({ id: randomBytes(4).toString('hex'), pattern });
    }
    return this.set(data);
  }

  async removeAllow(agentId: string, idOrPattern: string): Promise<ExecApprovalsFile> {
    const data = structuredClone(this.get());
    const agent = data.agents[agentId];
    if (agent)
      agent.allowlist = agent.allowlist.filter(
        (e) => e.id !== idOrPattern && e.pattern !== idOrPattern,
      );
    return this.set(data);
  }

  evaluate(
    command: string,
    agentId: string,
    extra: { allow?: string[]; deny?: string[] } = {},
  ): ExecGate & { risk: RiskAssessment } {
    const risk = assessShellCommand(command, extra);
    const { defaults } = this.get();
    if (risk.level === 'blocked')
      return { action: 'deny', reason: `blocked: ${risk.reason}`, risk };
    if (defaults.security === 'deny')
      return { action: 'deny', reason: 'host exec is disabled (security=deny)', risk };

    const matched = this.match(command, agentId);
    const safe = defaults.autoAllowSafe && risk.level === 'low';
    const allowlisted = defaults.security === 'full' || Boolean(matched) || safe;

    if (defaults.ask === 'always') return { action: 'ask', reason: 'ask=always', risk };
    if (allowlisted) {
      return {
        action: 'allow',
        reason: matched ? `allowlist: ${matched}` : safe ? 'read-only command' : 'security=full',
        ...(matched && { matched }),
        risk,
      };
    }
    if (defaults.ask === 'off')
      return { action: 'deny', reason: 'not in allowlist (ask=off)', risk };
    return { action: 'ask', reason: `not in allowlist — ${risk.reason}`, risk };
  }

  /** Record that an allowlist entry was used. */
  async touch(agentId: string, pattern: string, command: string): Promise<void> {
    const data = structuredClone(this.get());
    const e = data.agents[agentId]?.allowlist.find((x) => x.pattern === pattern);
    if (!e) return;
    e.lastUsedAt = Date.now();
    e.lastUsedCommand = command;
    await this.set(data);
  }

  /** Pause until decided; resolves with the decision ("timeout" applies askFallback upstream). */
  request(
    req: Omit<ExecApprovalRequest['request'], 'host'>,
    signal?: AbortSignal,
  ): Promise<ExecApprovalResolved> {
    const now = Date.now();
    const timeoutMs = this.get().defaults.timeoutSeconds * 1000;
    const approval: ExecApprovalRequest = {
      id: randomBytes(4).toString('hex'),
      request: { ...req, host: 'gateway' },
      createdAtMs: now,
      expiresAtMs: now + timeoutMs,
    };
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle('timeout', 'timeout'), timeoutMs);
      const onAbort = () => settle('deny', 'aborted');
      const settle = (decision: ExecDecision | 'timeout', by: string) => {
        if (!this.pending.has(approval.id)) return;
        this.pending.delete(approval.id);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const resolved: ExecApprovalResolved = {
          id: approval.id,
          decision,
          resolvedBy: by,
          ts: Date.now(),
          request: approval.request,
        };
        this.emit('resolved', resolved);
        resolve(resolved);
      };
      this.pending.set(approval.id, { req: approval, settle });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.emit('requested', approval);
    });
  }

  resolve(id: string, decision: ExecDecision, by: string): boolean {
    const p =
      this.pending.get(id) ?? [...this.pending.values()].find((x) => x.req.id.startsWith(id));
    if (!p) return false;
    if (decision === 'allow-always')
      void this.addAllow(p.req.request.agentId, p.req.request.command).catch(() => undefined);
    p.settle(decision, by);
    return true;
  }

  list(): ExecApprovalRequest[] {
    return [...this.pending.values()].map((p) => p.req);
  }

  cancelAll(): void {
    for (const p of [...this.pending.values()]) p.settle('deny', 'shutdown');
  }

  private match(command: string, agentId: string): string | undefined {
    const list = [
      ...(this.get().agents[agentId]?.allowlist ?? []),
      ...(this.get().agents['*']?.allowlist ?? []),
    ];
    const cmd = command.trim();
    for (const e of list) {
      if (globMatch(e.pattern.trim(), cmd)) return e.pattern;
    }
    return undefined;
  }
}

/** `*` matches anything; case-insensitive on Windows. */
export function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp(
    `^${pattern.split('*').map(escapeRe).join('.*')}$`,
    process.platform === 'win32' ? 'is' : 's',
  );
  return re.test(value);
}

function escapeRe(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}
