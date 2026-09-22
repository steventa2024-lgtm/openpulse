import os from 'node:os';
import { z } from 'zod';
import { shellInvocation } from '../../tools/process.js';
import type { ProcessSession } from '../process-registry.js';
import { resolvePath } from './fs-tools.js';
import { clip, defineTool, fail, ok, type ToolContext } from './types.js';

const MAX_OUTPUT_CHARS = 30_000;

export function createExecTool(shellPath?: string) {
  const shell = shellInvocation('', shellPath).name;
  return defineTool({
    name: 'exec',
    description:
      `Run a shell command on the host (${os.platform()}, ${shell}; write commands in ${shell} syntax). ` +
      'Runs in the workspace unless workdir is given. Commands still running after yieldMs are ' +
      'backgrounded: you get a sessionId to use with the process tool (poll/log/write/kill). ' +
      "Set background=true to return immediately. Risky commands may pause for the user's approval; " +
      'if denied, do not retry another way.',
    input: z.object({
      command: z.string().min(1),
      workdir: z.string().optional(),
      env: z.record(z.string(), z.string()).optional(),
      timeout: z
        .number()
        .int()
        .min(1)
        .max(86_400)
        .optional()
        .describe('Seconds before the process is killed.'),
      yieldMs: z.number().int().min(0).max(600_000).optional(),
      background: z.boolean().optional(),
    }),
    summarize: (i) => `$ ${i.command}`,
    async execute(input, ctx) {
      const { approvals } = ctx.services;
      const gate = approvals.evaluate(input.command, ctx.agentId);
      if (gate.action === 'deny') {
        ctx.log.warn(`exec denied: ${input.command}`, { reason: gate.reason });
        return fail(
          `Exec denied (${gate.reason}). Do not retry this command another way; tell the user.`,
        );
      }
      if (gate.action === 'ask') {
        ctx.log.info(`exec approval requested: ${input.command}`, { reason: gate.reason });
        const decision = await approvals.request(
          {
            command: input.command,
            cwd: input.workdir ? resolvePath(input.workdir, ctx.workspace) : ctx.workspace,
            agentId: ctx.agentId,
            sessionKey: ctx.sessionKey,
            risk: gate.risk,
          },
          ctx.signal,
        );
        if (decision.decision === 'timeout') {
          const fallback = approvals.get().defaults.askFallback;
          if (fallback !== 'full') {
            return fail(
              'Exec approval timed out, so the command was not run. Ask the user how to proceed.',
            );
          }
        } else if (decision.decision === 'deny') {
          return fail(
            `Exec denied by ${decision.resolvedBy}. Do not retry this command another way; ask the user how to proceed.`,
          );
        }
      } else if (gate.matched) {
        void approvals.touch(ctx.agentId, gate.matched, input.command);
      }
      return runExec(input, ctx, shellPath);
    },
  });
}

async function runExec(
  input: {
    command: string;
    workdir?: string | undefined;
    env?: Record<string, string> | undefined;
    timeout?: number | undefined;
    yieldMs?: number | undefined;
    background?: boolean | undefined;
  },
  ctx: ToolContext,
  shellPath?: string,
) {
  const cfg = ctx.config.tools.exec;
  const session = ctx.services.processes.start({
    agentId: ctx.agentId,
    command: input.command,
    cwd: input.workdir ? resolvePath(input.workdir, ctx.workspace) : ctx.workspace,
    env: { ...process.env, ...ctx.extraEnv, ...(input.env ?? {}) },
    timeoutMs: (input.timeout ?? cfg.timeoutSec) * 1000,
    ...(shellPath !== undefined && { shellPath }),
  });
  if (input.background) {
    return ok(`Started in background. sessionId=${session.id} (use process poll/log/kill).`);
  }
  const finished = await ctx.services.processes.waitFor(
    session,
    input.yieldMs ?? cfg.yieldMs,
    ctx.signal,
  );
  if (!finished) {
    session.pollOffset = session.output.length;
    return ok(
      `Still running after ${((input.yieldMs ?? cfg.yieldMs) / 1000).toFixed(0)}s → backgrounded as sessionId=${session.id}.\n` +
        `Output so far:\n${clip(session.output, 4000) || '(none)'}`,
    );
  }
  ctx.services.processes.remove(session.id);
  return formatExit(session);
}

function formatExit(s: ProcessSession) {
  const secs = (((s.endedAt ?? Date.now()) - s.startedAt) / 1000).toFixed(1);
  const head =
    s.status === 'timeout'
      ? `Timed out after ${secs}s (killed)`
      : s.status === 'killed'
        ? `Killed after ${secs}s`
        : s.status === 'failed'
          ? 'Failed to start'
          : `Exit code ${s.exitCode} (${secs}s)`;
  const body = s.output.trimEnd() || '(no output)';
  const text = clip(`${head}\n${body}`, MAX_OUTPUT_CHARS);
  return s.status === 'exited' && s.exitCode === 0 ? ok(text) : fail(text);
}

export const processTool = defineTool({
  name: 'process',
  description:
    'Manage backgrounded exec sessions. Actions: list; poll {sessionId} (new output + status); log {sessionId, offset?, limit?} (lines); write {sessionId, data} (stdin); kill {sessionId}; remove {sessionId}.',
  input: z.object({
    action: z.enum(['list', 'poll', 'log', 'write', 'kill', 'remove']),
    sessionId: z.string().optional(),
    data: z.string().optional(),
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).optional(),
  }),
  summarize: (i) => `process ${i.action}${i.sessionId ? ` ${i.sessionId}` : ''}`,
  // eslint-disable-next-line @typescript-eslint/require-await -- the registry is in-memory, but the Tool contract is async
  async execute(input, ctx) {
    const reg = ctx.services.processes;
    if (input.action === 'list') {
      const rows = reg
        .list(ctx.agentId)
        .map(
          (s) =>
            `${s.id}  ${s.status.padEnd(7)}  ${Math.round((Date.now() - s.startedAt) / 1000)}s  ${s.command}`,
        );
      return ok(rows.join('\n') || 'No process sessions.');
    }
    if (!input.sessionId) return fail('"sessionId" is required.');
    const s = reg.get(input.sessionId, ctx.agentId);
    if (!s) return fail(`No process session ${input.sessionId}.`);
    switch (input.action) {
      case 'poll': {
        const fresh = s.output.slice(s.pollOffset);
        s.pollOffset = s.output.length;
        const status = s.status === 'running' ? 'running' : `${s.status} (exit ${s.exitCode})`;
        return ok(`status: ${status}\n${clip(fresh, MAX_OUTPUT_CHARS) || '(no new output)'}`);
      }
      case 'log': {
        const lines = s.output.split('\n');
        const limit = input.limit ?? 200;
        const start = input.offset ?? Math.max(0, lines.length - limit);
        return ok(
          clip(lines.slice(start, start + limit).join('\n'), MAX_OUTPUT_CHARS) || '(empty)',
        );
      }
      case 'write':
        return reg.write(s.id, input.data ?? '') ? ok('Written.') : fail('Process is not running.');
      case 'kill':
        return reg.kill(s.id) ? ok('Killed.') : fail('Process is not running.');
      case 'remove':
        reg.remove(s.id);
        return ok('Removed.');
    }
    return fail('Unknown action');
  },
});
