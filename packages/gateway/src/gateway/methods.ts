import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { KNOWN_MODELS } from '../agent/models.js';
import { ConfigSchema, THINKING_LEVELS, UI_HINTS } from '../config/schema.js';
import { ConfigError, patchForPath } from '../config/store.js';
import type { Runtime } from '../runtime.js';
import { appendTranscript, readTranscript, type ContentPart } from '../sessions/transcript.js';
import type { ProjectError } from '../workspace/projects.js';
import { BOOTSTRAP_FILES } from '../workspace/workspace.js';
import { VERSION } from '../version.js';
import { GatewayError } from './protocol.js';
import { WORKSPACE_METHODS } from './workspace-methods.js';

export interface MethodContext {
  rt: Runtime;
  connId: string;
  client: { id: string; mode: string; displayName?: string };
  presence: () => unknown[];
  connectionCount: () => number;
  broadcast: (event: string, payload: unknown) => void;
}

export type Handler = (params: Record<string, unknown>, ctx: MethodContext) => unknown;

function parse<S extends z.ZodType>(schema: S, params: unknown): z.output<S> {
  const r = schema.safeParse(params ?? {});
  if (!r.success) {
    throw new GatewayError(
      'INVALID_REQUEST',
      r.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`).join('; '),
    );
  }
  return r.data;
}

const MAX_HISTORY_TEXT = 40_000;

function displayMessages(entries: Awaited<ReturnType<typeof readTranscript>>, limit: number) {
  return entries.slice(-limit).map((e) => {
    const m = e.message;
    const clipParts = (parts: ContentPart[]) =>
      parts.map((p) =>
        p.type === 'text' && p.text.length > MAX_HISTORY_TEXT
          ? { ...p, text: `${p.text.slice(0, MAX_HISTORY_TEXT)}\n[chat.history truncated]` }
          : p,
      );
    return { id: e.id, ...m, content: clipParts(m.content) };
  });
}

function healthSnapshot(rt: Runtime) {
  return {
    ok: true,
    ts: Date.now(),
    version: VERSION,
    uptimeMs: Date.now() - rt.startedAt,
    configValid: rt.config.get().valid,
    channels: rt.channels.status(),
    heartbeat: {
      enabled: rt.heartbeat.isEnabled(),
      every: rt.cfg.agents.defaults.heartbeat.every,
      nextRunAt: rt.heartbeat.nextRunAt() ?? null,
      last: rt.heartbeat.lastEvent() ?? null,
    },
    cron: rt.cron.status(),
    activeRuns: rt.agent.activeRuns().length,
    pendingApprovals: rt.approvals.list().length,
  };
}

const CORE_METHODS: Record<string, Handler> = {
  health: (_p, { rt }) => healthSnapshot(rt),

  status: async (_p, ctx) => {
    const { rt } = ctx;
    return {
      ...healthSnapshot(rt),
      stateDir: rt.paths.stateDir,
      configPath: rt.paths.configPath,
      workspace: rt.workspaceDir,
      model: rt.cfg.agents.defaults.model.primary,
      mainSessionKey: rt.agent.mainKey,
      sessions: (await rt.sessions.list()).length,
      connections: ctx.connectionCount(),
      node: process.version,
      platform: process.platform,
    };
  },

  'system-presence': (_p, ctx) => ({ presence: ctx.presence() }),
  'last-heartbeat': (_p, { rt }) => rt.heartbeat.lastEvent() ?? null,
  'set-heartbeats': (p, { rt }) => {
    const { enabled } = parse(z.object({ enabled: z.boolean() }), p);
    rt.heartbeat.setEnabled(enabled);
    return { enabled };
  },
  wake: (p, { rt }) => {
    const { text, mode } = parse(
      z.object({
        text: z.string().optional(),
        mode: z.enum(['now', 'next-heartbeat']).default('now'),
      }),
      p,
    );
    if (text) rt.cron.wake(text, mode);
    else rt.heartbeat.requestNow('wake');
    return { ok: true };
  },
  'heartbeat.run': async (_p, { rt }) => rt.heartbeat.runOnce('manual'),

  'models.list': (_p, { rt }) => {
    const cfg = rt.cfg.agents.defaults;
    const refs = new Map(KNOWN_MODELS.map((m) => [m.ref, m]));
    for (const [ref, e] of Object.entries(cfg.models))
      refs.set(ref, { ref, name: e.alias ?? ref, provider: ref.split('/')[0] ?? '' });
    if (!refs.has(cfg.model.primary))
      refs.set(cfg.model.primary, {
        ref: cfg.model.primary,
        name: cfg.model.primary,
        provider: cfg.model.primary.split('/')[0] ?? '',
      });
    return {
      primary: cfg.model.primary,
      fallbacks: cfg.model.fallbacks,
      models: [...refs.values()],
    };
  },

  // ---- chat ------------------------------------------------------------------------------------
  'chat.history': async (p, { rt }) => {
    const { sessionKey, limit } = parse(
      z.object({
        sessionKey: z.string().default('main'),
        limit: z.number().int().min(1).max(1000).default(200),
      }),
      p,
    );
    const key = rt.canonical(sessionKey);
    const entry = await rt.sessions.ensure(key);
    const entries = await readTranscript(rt.sessions.transcriptFile(entry));
    return {
      sessionKey: key,
      sessionId: entry.sessionId,
      thinkingLevel: entry.thinkingLevel ?? rt.cfg.agents.defaults.thinkingDefault,
      model: entry.modelOverride ?? rt.cfg.agents.defaults.model.primary,
      running: rt.agent.isBusy(key),
      messages: displayMessages(entries, limit),
    };
  },
  'chat.send': async (p, ctx) => {
    const { sessionKey, message, idempotencyKey } = parse(
      z.object({
        sessionKey: z.string().default('main'),
        message: z.string().min(1),
        idempotencyKey: z.string().optional(),
      }),
      p,
    );
    const { rt } = ctx;
    const key = rt.canonical(sessionKey);
    await rt.sessions.ensure(key);
    const res = await rt.agent.dispatch({
      sessionKey: key,
      message,
      source: {
        kind: 'user',
        channel: 'webchat',
        senderName: ctx.client.displayName ?? 'Control UI',
      },
      ...(idempotencyKey !== undefined && { idempotencyKey }),
    });
    if (res.status === 'command' && res.reply) {
      await injectNote(ctx, key, res.reply);
      return { runId: null, status: 'ok', command: true };
    }
    return { runId: res.runId, status: res.status };
  },
  'chat.abort': (p, { rt }) => {
    const { sessionKey, runId } = parse(
      z.object({ sessionKey: z.string().default('main'), runId: z.string().optional() }),
      p,
    );
    return {
      aborted: rt.agent.abort(rt.canonical(sessionKey), { ...(runId !== undefined && { runId }) }),
    };
  },
  'chat.inject': async (p, ctx) => {
    const { sessionKey, message } = parse(
      z.object({ sessionKey: z.string().default('main'), message: z.string().min(1) }),
      p,
    );
    await injectNote(ctx, ctx.rt.canonical(sessionKey), message);
    return { ok: true };
  },

  // ---- sessions --------------------------------------------------------------------------------
  'sessions.list': async (p, { rt }) => {
    const { limit, activeMinutes } = parse(
      z.object({
        limit: z.number().int().min(1).max(5000).default(200),
        activeMinutes: z.number().int().min(1).optional(),
      }),
      p,
    );
    const cutoff = activeMinutes ? Date.now() - activeMinutes * 60_000 : 0;
    const rows = (await rt.sessions.list()).filter((s) => s.updatedAt >= cutoff).slice(0, limit);
    return {
      defaults: {
        model: rt.cfg.agents.defaults.model.primary,
        thinkingLevel: rt.cfg.agents.defaults.thinkingDefault,
        contextTokens: rt.cfg.agents.defaults.contextTokens,
        mainSessionKey: rt.agent.mainKey,
      },
      sessions: rows.map((s) => ({ ...s, running: rt.agent.isBusy(s.key) })),
    };
  },
  'sessions.patch': async (p, ctx) => {
    const { key, thinkingLevel, verboseLevel, model, label } = parse(
      z.object({
        key: z.string(),
        thinkingLevel: z.enum(THINKING_LEVELS).nullable().optional(),
        verboseLevel: z.enum(['on', 'off']).nullable().optional(),
        model: z.string().nullable().optional(),
        label: z.string().nullable().optional(),
      }),
      p,
    );
    const k = ctx.rt.canonical(key);
    await ctx.rt.sessions.ensure(k);
    const entry = await ctx.rt.sessions.patch(k, {
      ...(thinkingLevel !== undefined && { thinkingLevel }),
      ...(verboseLevel !== undefined && { verboseLevel }),
      ...(model !== undefined && { modelOverride: model }),
      ...(label !== undefined && { label }),
    } as never);
    ctx.broadcast('sessions.changed', { key: k, reason: 'patch' });
    return { key: k, entry };
  },
  'sessions.reset': async (p, ctx) => {
    const { key } = parse(z.object({ key: z.string().default('main') }), p);
    const k = ctx.rt.canonical(key);
    ctx.rt.agent.abort(k);
    const entry = await ctx.rt.sessions.reset(k);
    ctx.broadcast('sessions.changed', { key: k, reason: 'reset' });
    return { key: k, sessionId: entry.sessionId };
  },
  'sessions.delete': async (p, ctx) => {
    const { key, deleteTranscript } = parse(
      z.object({ key: z.string(), deleteTranscript: z.boolean().default(false) }),
      p,
    );
    const k = ctx.rt.canonical(key);
    if (k === ctx.rt.agent.mainKey)
      throw new GatewayError('INVALID_REQUEST', 'The main session cannot be deleted (use reset).');
    ctx.rt.agent.abort(k);
    const deleted = await ctx.rt.sessions.delete(k, { deleteTranscript });
    ctx.broadcast('sessions.changed', { key: k, reason: 'delete' });
    return { deleted };
  },

  // ---- projects --------------------------------------------------------------------------------
  'projects.list': async (_p, { rt }) => ({
    projects: await rt.projects.list(),
    active: (await rt.projects.active()) ?? null,
    roots: rt.fsPolicy.describe(),
  }),
  'projects.add': async (p, ctx) => {
    const { path: dir, name } = parse(
      z.object({ path: z.string().min(1), name: z.string().optional() }),
      p,
    );
    try {
      const project = await ctx.rt.projects.add({ path: dir, ...(name !== undefined && { name }) });
      await ctx.rt.refreshFsPolicy();
      ctx.rt.log.info(`project added: ${project.name}`, { path: project.path });
      ctx.broadcast('projects.changed', { reason: 'add', id: project.id });
      return { project };
    } catch (error) {
      throw new GatewayError(
        (error as ProjectError).code === 'NOT_FOUND' ? 'NOT_FOUND' : 'INVALID_REQUEST',
        (error as Error).message,
      );
    }
  },
  'projects.remove': async (p, ctx) => {
    const { id } = parse(z.object({ id: z.string() }), p);
    const removed = await ctx.rt.projects.remove(id);
    await ctx.rt.refreshFsPolicy();
    ctx.broadcast('projects.changed', { reason: 'remove', id });
    return { removed };
  },
  'projects.select': async (p, ctx) => {
    const { id } = parse(z.object({ id: z.string() }), p);
    try {
      const project = await ctx.rt.projects.setActive(id);
      ctx.broadcast('projects.changed', { reason: 'select', id });
      return { project };
    } catch (error) {
      throw new GatewayError('NOT_FOUND', (error as Error).message);
    }
  },
  'projects.patch': async (p, ctx) => {
    const { id, patch } = parse(
      z.object({
        id: z.string(),
        patch: z.object({
          name: z.string().min(1).max(120).optional(),
          extraReadRoots: z.array(z.string()).optional(),
        }),
      }),
      p,
    );
    try {
      const project = await ctx.rt.projects.patch(id, patch);
      await ctx.rt.refreshFsPolicy();
      ctx.broadcast('projects.changed', { reason: 'patch', id });
      return { project };
    } catch (error) {
      throw new GatewayError('NOT_FOUND', (error as Error).message);
    }
  },

  // ---- security --------------------------------------------------------------------------------
  'security.get': (_p, { rt }) => ({
    mode: rt.cfg.security.mode,
    policy: rt.fsPolicy.describe(),
    config: rt.cfg.security,
    exec: rt.approvals.get().defaults,
  }),
  'security.set': async (p, { rt }) => {
    const patch = parse(
      z.object({
        mode: z.enum(['read-only', 'balanced', 'custom']).optional(),
        readRoots: z.array(z.string()).optional(),
        writeRoots: z.array(z.string()).optional(),
        denyPatterns: z.array(z.string()).optional(),
        tools: z.record(z.string(), z.boolean()).optional(),
      }),
      p,
    );
    await configWrite(() => rt.config.patch({ security: patch }));
    await rt.refreshFsPolicy();
    return { mode: rt.cfg.security.mode, policy: rt.fsPolicy.describe() };
  },

  // ---- channels & pairing ----------------------------------------------------------------------
  'channels.status': async (p, { rt }) => {
    const { probe } = parse(z.object({ probe: z.boolean().default(false) }), p);
    const channels = rt.channels.status();
    const probes: Record<string, unknown> = {};
    if (probe) {
      for (const c of channels) {
        const plugin = rt.channels.get(c.id);
        if (plugin?.probe)
          probes[c.id] = await plugin
            .probe()
            .catch((e: unknown) => ({ ok: false, error: (e as Error).message }));
      }
    }
    return { ts: Date.now(), channels, probes };
  },
  'channels.pairing.list': async (p, { rt }) => {
    const { channel } = parse(z.object({ channel: z.string().default('telegram') }), p);
    return {
      channel,
      requests: await rt.pairing.listPending(channel),
      allowFrom: await rt.pairing.allowFrom(channel),
    };
  },
  'channels.pairing.approve': async (p, { rt }) => {
    const { channel, code } = parse(z.object({ channel: z.string(), code: z.string() }), p);
    const req = await rt.pairing.approve(channel, code);
    if (!req) throw new GatewayError('NOT_FOUND', `No pending pairing code ${code} for ${channel}`);
    rt.log.info(`pairing approved: ${channel}:${req.userId}`);
    const plugin = rt.channels.get(channel);
    await plugin
      ?.send(req.userId, '✅ You are paired with OpenPulse. Say hello!')
      .catch(() => undefined);
    return { approved: true, userId: req.userId };
  },
  'channels.pairing.reject': async (p, { rt }) => {
    const { channel, code } = parse(z.object({ channel: z.string(), code: z.string() }), p);
    return { rejected: await rt.pairing.reject(channel, code) };
  },
  'channels.allow.remove': async (p, { rt }) => {
    const { channel, userId } = parse(z.object({ channel: z.string(), userId: z.string() }), p);
    await rt.pairing.removeAllow(channel, userId);
    return { ok: true };
  },

  // ---- cron ------------------------------------------------------------------------------------
  'cron.status': (_p, { rt }) => rt.cron.status(),
  'cron.list': (p, { rt }) => {
    const { includeDisabled } = parse(z.object({ includeDisabled: z.boolean().default(true) }), p);
    return { jobs: rt.cron.list(includeDisabled) };
  },
  'cron.add': async (p, { rt }) => wrapCron(() => rt.cron.add(p.job ?? p)),
  'cron.update': async (p, { rt }) => {
    const { jobId, patch } = parse(
      z.object({ jobId: z.string(), patch: z.record(z.string(), z.unknown()) }),
      p,
    );
    return wrapCron(() => rt.cron.update(jobId, patch));
  },
  'cron.remove': async (p, { rt }) =>
    wrapCron(() => rt.cron.remove(parse(z.object({ jobId: z.string() }), p).jobId)),
  'cron.run': async (p, { rt }) =>
    wrapCron(() => rt.cron.run(parse(z.object({ jobId: z.string() }), p).jobId)),
  'cron.runs': async (p, { rt }) => {
    const { jobId, limit } = parse(
      z.object({ jobId: z.string(), limit: z.number().int().min(1).max(500).default(50) }),
      p,
    );
    return { runs: await rt.cron.runs(jobId, limit) };
  },

  // ---- skills ----------------------------------------------------------------------------------
  'skills.status': async (_p, { rt }) => ({
    workspaceDir: path.join(rt.workspaceDir, 'skills'),
    managedDir: rt.paths.managedSkillsDir,
    skills: await rt.skillStatus(),
  }),
  'skills.update': async (p, { rt }) => {
    const { name, enabled, apiKey, env } = parse(
      z.object({
        name: z.string(),
        enabled: z.boolean().optional(),
        apiKey: z.string().nullable().optional(),
        env: z.record(z.string(), z.string()).nullable().optional(),
      }),
      p,
    );
    const entry: Record<string, unknown> = {};
    if (enabled !== undefined) entry.enabled = enabled;
    if (apiKey !== undefined) entry.apiKey = apiKey === '' ? null : apiKey;
    if (env !== undefined) entry.env = env;
    await configWrite(() => rt.config.patch({ skills: { entries: { [name]: entry } } }));
    return { ok: true, skills: await rt.skillStatus() };
  },

  // ---- nodes & devices -------------------------------------------------------------------------
  'node.list': (_p, ctx) => ({
    nodes: (ctx.presence() as { role?: string }[]).filter((x) => x.role === 'node'),
  }),
  'device.pair.list': async (_p, { rt }) => ({
    pending: await rt.devices.listPending(),
    paired: (await rt.devices.listPaired()).map(({ tokenHash: _t, ...d }) => d),
  }),
  'device.pair.approve': async (p, { rt }) => {
    const d = await rt.devices.approveRequest(
      parse(z.object({ requestId: z.string() }), p).requestId,
    );
    if (!d) throw new GatewayError('NOT_FOUND', 'No such pairing request');
    return { approved: true, deviceId: d.deviceId };
  },
  'device.pair.reject': async (p, { rt }) => ({
    rejected: await rt.devices.rejectRequest(
      parse(z.object({ requestId: z.string() }), p).requestId,
    ),
  }),
  'device.pair.remove': async (p, { rt }) => ({
    removed: await rt.devices.remove(parse(z.object({ deviceId: z.string() }), p).deviceId),
  }),

  // ---- exec approvals --------------------------------------------------------------------------
  'exec.approvals.get': (_p, { rt }) => ({ path: rt.approvals.file, file: rt.approvals.get() }),
  'exec.approvals.set': async (p, { rt }) => {
    const { file } = parse(z.object({ file: z.unknown() }), p);
    try {
      return { path: rt.approvals.file, file: await rt.approvals.set(file) };
    } catch (e) {
      throw new GatewayError('INVALID_REQUEST', (e as Error).message);
    }
  },
  'exec.approval.list': (_p, { rt }) => ({ pending: rt.approvals.list() }),
  'exec.approval.resolve': (p, ctx) => {
    const { id, decision } = parse(
      z.object({ id: z.string(), decision: z.enum(['allow-once', 'allow-always', 'deny']) }),
      p,
    );
    const ok = ctx.rt.approvals.resolve(
      id,
      decision,
      `${ctx.client.mode}:${ctx.client.displayName ?? ctx.client.id}`,
    );
    if (!ok) throw new GatewayError('NOT_FOUND', 'No pending approval with that id');
    return { ok };
  },

  // ---- config ----------------------------------------------------------------------------------
  'config.get': (_p, { rt }) => {
    const s = rt.config.get();
    return {
      path: s.path,
      exists: s.exists,
      raw: s.raw,
      hash: s.hash,
      valid: s.valid,
      issues: s.issues,
      config: s.config,
    };
  },
  'config.schema': () => {
    const schema = z.toJSONSchema(ConfigSchema, { io: 'input', unrepresentable: 'any' });
    return { version: VERSION, schema, uiHints: UI_HINTS };
  },
  'config.set': async (p, { rt }) => {
    const { raw, baseHash } = parse(
      z.object({ raw: z.string(), baseHash: z.string().optional() }),
      p,
    );
    const s = await configWrite(() => rt.config.set(raw, baseHash));
    return { hash: s.hash, valid: s.valid };
  },
  'config.patch': async (p, { rt }) => {
    const {
      raw,
      patch,
      baseHash,
      path: dotted,
      value,
    } = parse(
      z.object({
        raw: z.string().optional(),
        patch: z.record(z.string(), z.unknown()).optional(),
        baseHash: z.string().optional(),
        path: z.string().optional(),
        value: z.unknown().optional(),
      }),
      p,
    );
    const delta = raw ?? patch ?? (dotted ? patchForPath(dotted, value ?? null) : undefined);
    if (!delta) throw new GatewayError('INVALID_REQUEST', 'raw, patch or path is required');
    const s = await configWrite(() => rt.config.patch(delta, baseHash));
    return { hash: s.hash, valid: s.valid };
  },
  'config.apply': async (p, ctx) => {
    const { raw, baseHash } = parse(
      z.object({ raw: z.string(), baseHash: z.string().optional() }),
      p,
    );
    const before = ctx.rt.cfg.gateway;
    const s = await configWrite(() => ctx.rt.config.set(raw, baseHash));
    const restartRequired =
      JSON.stringify(before.port) !== JSON.stringify(s.config.gateway.port) ||
      before.bind !== s.config.gateway.bind;
    return { hash: s.hash, valid: s.valid, restartRequired };
  },

  // ---- logs, agent, send -----------------------------------------------------------------------
  'logs.tail': async (p, { rt }) => {
    const q = parse(
      z.object({
        cursor: z.number().int().min(0).optional(),
        limit: z.number().int().optional(),
        maxBytes: z.number().int().optional(),
      }),
      p,
    );
    return rt.logs.tail({
      ...(q.cursor !== undefined && { cursor: q.cursor }),
      ...(q.limit !== undefined && { limit: q.limit }),
      ...(q.maxBytes !== undefined && { maxBytes: q.maxBytes }),
    });
  },
  agent: async (p, ctx) => {
    const { sessionKey, message, deliver, channel, to } = parse(
      z.object({
        sessionKey: z.string().default('main'),
        message: z.string().min(1),
        deliver: z.boolean().default(false),
        channel: z.string().optional(),
        to: z.string().optional(),
      }),
      p,
    );
    const { rt } = ctx;
    const key = rt.canonical(sessionKey);
    const result = await rt.agent.runAndWait({
      sessionKey: key,
      message,
      source: { kind: 'user', channel: ctx.client.mode === 'cli' ? 'cli' : 'webchat' },
    });
    if (deliver && channel && to && result.text) await rt.channels.send(channel, to, result.text);
    return result;
  },
  send: async (p, { rt }) => {
    const { channel, to, message } = parse(
      z.object({ channel: z.string(), to: z.string(), message: z.string().min(1) }),
      p,
    );
    await rt.channels.send(channel, to, message);
    return { ok: true };
  },

  // ---- agent workspace files -------------------------------------------------------------------
  'agents.list': (_p, { rt }) => ({
    defaultId: rt.agentId,
    agents: [
      {
        id: rt.agentId,
        workspace: rt.workspaceDir,
        model: rt.cfg.agents.defaults.model.primary,
        identity: rt.cfg.ui.assistant ?? {},
      },
    ],
  }),
  'agents.files.list': async (_p, { rt }) => {
    const names = [...BOOTSTRAP_FILES, 'MEMORY.md'];
    return {
      workspace: rt.workspaceDir,
      files: await Promise.all(
        names.map(async (name) => {
          const file = path.join(rt.workspaceDir, name);
          const st = await fsp.stat(file).catch(() => undefined);
          return {
            name,
            path: file,
            exists: Boolean(st),
            size: st?.size ?? 0,
            updatedAtMs: st?.mtimeMs ?? null,
          };
        }),
      ),
    };
  },
  'agents.files.get': async (p, { rt }) => {
    const { name } = parse(
      z.object({ name: z.enum([...BOOTSTRAP_FILES, 'MEMORY.md'] as [string, ...string[]]) }),
      p,
    );
    const file = path.join(rt.workspaceDir, name);
    return { name, content: fs.existsSync(file) ? await fsp.readFile(file, 'utf8') : '' };
  },
  'agents.files.set': async (p, { rt }) => {
    const { name, content } = parse(
      z.object({
        name: z.enum([...BOOTSTRAP_FILES, 'MEMORY.md'] as [string, ...string[]]),
        content: z.string().max(500_000),
      }),
      p,
    );
    await fsp.writeFile(path.join(rt.workspaceDir, name), content, 'utf8');
    return { ok: true };
  },
};

/** Every method the gateway answers: the core set plus the workspace, git and editor calls. */
export const METHODS: Record<string, Handler> = { ...CORE_METHODS, ...WORKSPACE_METHODS };

async function injectNote(ctx: MethodContext, key: string, text: string): Promise<void> {
  const entry = await ctx.rt.sessions.ensure(key);
  const timestamp = Date.now();
  await appendTranscript(ctx.rt.sessions.transcriptFile(entry), entry.sessionId, {
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp,
    injected: true,
  });
  ctx.broadcast('chat', {
    runId: `inject-${timestamp}`,
    sessionKey: key,
    seq: 1,
    state: 'final',
    message: { role: 'assistant', content: [{ type: 'text', text }], timestamp },
    injected: true,
  });
}

async function configWrite<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ConfigError) {
      throw new GatewayError(e.code === 'CONFLICT' ? 'CONFLICT' : 'INVALID_REQUEST', e.message, {
        issues: e.issues,
      });
    }
    throw new GatewayError('INVALID_REQUEST', (e as Error).message);
  }
}

async function wrapCron<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof z.ZodError)
      throw new GatewayError(
        'INVALID_REQUEST',
        e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    if (/Unknown cron job/.test((e as Error).message))
      throw new GatewayError('NOT_FOUND', (e as Error).message);
    throw e;
  }
}
