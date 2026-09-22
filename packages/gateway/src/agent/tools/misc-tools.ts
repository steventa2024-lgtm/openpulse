import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { isInsideWorkspace } from '../../workspace/workspace.js';
import { clip, defineTool, fail, ok } from './types.js';

const json = (v: unknown) => clip(JSON.stringify(v, null, 2), 30_000);

export const cronTool = defineTool({
  name: 'cron',
  description:
    'Manage the gateway scheduler (reminders and recurring jobs). Actions: status; list; add {job}; update {jobId, patch}; remove {jobId}; run {jobId}; runs {jobId}; wake {text, mode}. ' +
    'Job shape: {name, schedule: {kind:"at", at:"<ISO>"} | {kind:"every", everyMs} | {kind:"cron", expr:"0 7 * * *", tz?}, ' +
    'sessionTarget: "main" (payload {kind:"systemEvent", text}) | "isolated" (payload {kind:"agentTurn", message}), ' +
    'wakeMode?: "now"|"next-heartbeat", delivery?: {mode:"announce"|"none"|"webhook", channel?, to?}, deleteAfterRun?}. ' +
    'Use main+systemEvent for reminders that should appear in this chat; isolated+agentTurn for background chores whose summary is announced.',
  input: z.object({
    action: z.enum(['status', 'list', 'add', 'update', 'remove', 'run', 'runs', 'wake']),
    job: z.record(z.string(), z.unknown()).optional(),
    jobId: z.string().optional(),
    patch: z.record(z.string(), z.unknown()).optional(),
    includeDisabled: z.boolean().optional(),
    text: z.string().optional(),
    mode: z.enum(['now', 'next-heartbeat']).optional(),
  }),
  summarize: (i) =>
    `cron ${i.action}${i.jobId ? ` ${i.jobId}` : ''}${typeof i.job?.name === 'string' ? ` "${i.job.name}"` : ''}`,
  async execute(input, ctx) {
    const cron = ctx.services.cron;
    const need = (v: unknown, name: string) => {
      if (v === undefined) throw new Error(`"${name}" is required for ${input.action}`);
    };
    try {
      switch (input.action) {
        case 'status':
          return ok(json(await cron.status()));
        case 'list':
          return ok(json(await cron.list(input.includeDisabled ?? true)));
        case 'add':
          need(input.job, 'job');
          return ok(json(await cron.add(input.job)));
        case 'update':
          need(input.jobId, 'jobId');
          need(input.patch, 'patch');
          return ok(json(await cron.update(input.jobId!, input.patch)));
        case 'remove':
          need(input.jobId, 'jobId');
          return ok(json(await cron.remove(input.jobId!)));
        case 'run':
          need(input.jobId, 'jobId');
          return ok(json(await cron.run(input.jobId!)));
        case 'runs':
          need(input.jobId, 'jobId');
          return ok(json(await cron.runs(input.jobId!, 20)));
        case 'wake':
          need(input.text, 'text');
          return ok(json(await cron.wake(input.text!, input.mode ?? 'now')));
      }
    } catch (error) {
      return fail(`cron ${input.action} failed: ${(error as Error).message}`);
    }
    return fail('Unknown action');
  },
});

export const messageTool = defineTool({
  name: 'message',
  description:
    "Send a message to a chat channel. Omit channel/to to reply on the current conversation's last route. Only use for proactive/out-of-band messages — normal replies are delivered automatically.",
  input: z.object({
    action: z.enum(['send']).default('send'),
    channel: z.string().optional(),
    to: z.string().optional(),
    message: z.string().min(1),
  }),
  summarize: (i) => `message ${i.channel ?? 'last'}${i.to ? `:${i.to}` : ''}`,
  async execute(input, ctx) {
    const m = ctx.services.messaging;
    let channel = input.channel;
    let to = input.to;
    if (!channel || !to) {
      const last = await m.lastRoute(ctx.sessionKey);
      channel ??= last?.channel;
      to ??= last?.to;
    }
    if (!channel || !to)
      return fail(`No target. Available channels: ${m.channels().join(', ') || 'none'}.`);
    if (!m.channels().includes(channel)) return fail(`Channel "${channel}" is not running.`);
    await m.send(channel, to, input.message);
    return ok(`Sent to ${channel}:${to}.`);
  },
});

export const sessionsListTool = defineTool({
  name: 'sessions_list',
  description: 'List conversation sessions (keys, kinds, last activity, tokens).',
  input: z.object({
    limit: z.number().int().min(1).max(200).optional(),
    activeMinutes: z.number().int().min(1).optional(),
  }),
  summarize: () => 'sessions_list',
  async execute(input, ctx) {
    return ok(json(await ctx.services.sessions.list(input)));
  },
});

export const sessionsHistoryTool = defineTool({
  name: 'sessions_history',
  description: 'Read recent messages from another session by key.',
  input: z.object({
    sessionKey: z.string().min(1),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  summarize: (i) => `sessions_history ${i.sessionKey}`,
  async execute(input, ctx) {
    return ok(json(await ctx.services.sessions.history(input.sessionKey, input.limit ?? 20)));
  },
});

export const sessionsSendTool = defineTool({
  name: 'sessions_send',
  description: "Send a message into another session and wait for that session's reply.",
  input: z.object({ sessionKey: z.string().min(1), message: z.string().min(1) }),
  summarize: (i) => `sessions_send ${i.sessionKey}`,
  async execute(input, ctx) {
    if (input.sessionKey === ctx.sessionKey) return fail('Cannot send to the current session.');
    return ok(await ctx.services.sessions.send(input.sessionKey, input.message, ctx.sessionKey));
  },
});

export const sessionStatusTool = defineTool({
  name: 'session_status',
  description: 'Show the current session: key, model, thinking level, token usage, time.',
  input: z.object({}),
  summarize: () => 'session_status',
  async execute(_input, ctx) {
    return ok(json(await ctx.services.sessions.status(ctx.sessionKey)));
  },
});

/** Keyword recall over MEMORY.md + memory/*.md (no embeddings needed). */
export const memorySearchTool = defineTool({
  name: 'memory_search',
  description:
    'Search your memory files (MEMORY.md and memory/*.md) for relevant notes. Returns snippets with path#line.',
  input: z.object({
    query: z.string().min(1),
    maxResults: z.number().int().min(1).max(50).optional(),
  }),
  summarize: (i) => `memory_search "${i.query}"`,
  async execute(input, ctx) {
    const files: string[] = [];
    const memFile = path.join(ctx.workspace, 'MEMORY.md');
    if (ctx.isMainSession && fs.existsSync(memFile)) files.push(memFile);
    const dir = path.join(ctx.workspace, 'memory');
    if (fs.existsSync(dir)) {
      for (const f of (await fsp.readdir(dir))
        .filter((f) => f.endsWith('.md'))
        .sort()
        .reverse())
        files.push(path.join(dir, f));
    }
    const terms = input.query
      .toLowerCase()
      .split(/\W+/)
      .filter((t) => t.length > 1);
    const hits: { score: number; ref: string; text: string }[] = [];
    for (const file of files) {
      const lines = (await fsp.readFile(file, 'utf8')).split(/\r?\n/);
      lines.forEach((line, i) => {
        const l = line.toLowerCase();
        const score = terms.reduce((s, t) => s + (l.includes(t) ? 1 : 0), 0);
        if (score > 0) {
          const snippet = lines
            .slice(Math.max(0, i - 1), i + 2)
            .join('\n')
            .trim();
          hits.push({
            score,
            ref: `${path.relative(ctx.workspace, file)}#${i + 1}`,
            text: snippet,
          });
        }
      });
    }
    hits.sort((a, b) => b.score - a.score);
    const top = hits.slice(0, input.maxResults ?? 8);
    return ok(top.map((h) => `${h.ref}\n${h.text}`).join('\n\n---\n\n') || 'No matches.');
  },
});

export const memoryGetTool = defineTool({
  name: 'memory_get',
  description:
    'Read a memory file (or a line range) from the workspace, e.g. memory/2026-09-18.md. Returns empty text if it does not exist yet.',
  input: z.object({
    path: z.string().min(1),
    from: z.number().int().min(1).optional(),
    lines: z.number().int().min(1).optional(),
  }),
  summarize: (i) => `memory_get ${i.path}`,
  async execute(input, ctx) {
    const file = path.resolve(ctx.workspace, input.path);
    if (!isInsideWorkspace(ctx.workspace, file))
      return fail('memory_get only reads files inside the workspace.');
    if (path.basename(file) === 'MEMORY.md' && !ctx.isMainSession)
      return fail('MEMORY.md is private to the main session.');
    if (!fs.existsSync(file)) return ok(JSON.stringify({ text: '', path: input.path }));
    const lines = (await fsp.readFile(file, 'utf8')).split(/\r?\n/);
    const start = (input.from ?? 1) - 1;
    const text = lines.slice(start, input.lines ? start + input.lines : undefined).join('\n');
    return ok(clip(text, 50_000));
  },
});
