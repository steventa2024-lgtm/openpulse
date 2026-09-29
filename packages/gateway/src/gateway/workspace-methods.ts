import path from 'node:path';
import { z } from 'zod';
import { ChangeError } from '../changes/proposals.js';
import { CheckpointError } from '../checkpoints/service.js';
import { McpError, renderToolResult } from '../mcp/client.js';
import { detectLocalProviders, inspectOllamaModel } from '../models/detect.js';
import { detectTestSuites } from '../testing/detect.js';
import { sanitizeValue } from '../debug/sanitize.js';
import { SkillRegistry, SkillRegistryError } from '../skills/registry.js';
import { WorkflowError } from '../workflows/engine.js';
import { buildTools } from '../agent/tools/index.js';
import { GitError, GitRepo, gitAvailable, gitClone } from '../git/git.js';
import type { Runtime } from '../runtime.js';
import { FileService, FileServiceError } from '../workspace/file-service.js';
import type { Project } from '../workspace/projects.js';
import { GatewayError } from './protocol.js';
import type { MethodContext } from './methods.js';

type Handler = (params: Record<string, unknown>, ctx: MethodContext) => unknown;

function parse<S extends z.ZodType>(schema: S, params: unknown): z.output<S> {
  const result = schema.safeParse(params ?? {});
  if (!result.success) {
    throw new GatewayError(
      'INVALID_REQUEST',
      result.error.issues
        .map((issue) => `${issue.path.join('.') || 'params'}: ${issue.message}`)
        .join('; '),
    );
  }
  return result.data;
}

/** The project a call refers to: the one named, otherwise the active one. */
async function projectOf(rt: Runtime, id?: string): Promise<Project> {
  const project = id ? await rt.projects.get(id) : await rt.projects.active();
  if (!project) {
    throw new GatewayError(
      'NOT_FOUND',
      id ? `No project with id ${id}` : 'No project is selected. Add one under Workspace first.',
    );
  }
  return project;
}

function filesOf(rt: Runtime, project: Project): FileService {
  return new FileService(project.path, rt.fsPolicy);
}

function registryOf(rt: Runtime): SkillRegistry {
  return new SkillRegistry(rt.paths.managedSkillsDir, path.join(rt.workspaceDir, 'skills'));
}

function repoOf(project: Project): GitRepo {
  return new GitRepo(project.path);
}

/** Translate service errors into protocol errors without leaking stack traces. */
function wrap<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((error: unknown) => {
    if (error instanceof FileServiceError) {
      const code =
        error.code === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : error.code === 'CONFLICT'
            ? 'CONFLICT'
            : 'INVALID_REQUEST';
      throw new GatewayError(code, error.message);
    }
    if (error instanceof GitError) throw new GatewayError('INVALID_REQUEST', error.message);
    if (error instanceof WorkflowError) {
      throw new GatewayError(
        error.code === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : error.code === 'CONFLICT'
            ? 'CONFLICT'
            : 'INVALID_REQUEST',
        error.message,
      );
    }
    if (error instanceof z.ZodError) {
      throw new GatewayError(
        'INVALID_REQUEST',
        error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; '),
      );
    }
    if (error instanceof SkillRegistryError) {
      throw new GatewayError(
        error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'INVALID_REQUEST',
        error.message,
      );
    }
    if (error instanceof McpError) {
      throw new GatewayError(
        error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'INVALID_REQUEST',
        error.message,
      );
    }
    if (error instanceof CheckpointError) {
      throw new GatewayError(
        error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'INVALID_REQUEST',
        error.message,
      );
    }
    if (error instanceof ChangeError) {
      throw new GatewayError(
        error.code === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : error.code === 'CONFLICT'
            ? 'CONFLICT'
            : 'INVALID_REQUEST',
        error.message,
      );
    }
    throw error;
  });
}

const ProjectRef = z.object({ projectId: z.string().optional() });

export const WORKSPACE_METHODS: Record<string, Handler> = {
  // ---- files -----------------------------------------------------------------------------------
  'workspace.tree': async (p, { rt }) => {
    const { projectId, dir, depth, includeHidden } = parse(
      ProjectRef.extend({
        dir: z.string().default('.'),
        depth: z.number().int().min(1).max(6).default(2),
        includeHidden: z.boolean().default(false),
      }),
      p,
    );
    const project = await projectOf(rt, projectId);
    return wrap(async () => ({
      project: { id: project.id, name: project.name, path: project.path },
      entries: await filesOf(rt, project).tree({ dir, depth, includeHidden }),
    }));
  },

  'workspace.file.read': async (p, { rt }) => {
    const { projectId, path: file } = parse(ProjectRef.extend({ path: z.string().min(1) }), p);
    const project = await projectOf(rt, projectId);
    return wrap(async () => filesOf(rt, project).read(file));
  },

  'workspace.file.write': async (p, ctx) => {
    const {
      projectId,
      path: file,
      content,
      baseHash,
    } = parse(
      ProjectRef.extend({
        path: z.string().min(1),
        content: z.string().max(8 * 1024 * 1024),
        /** Hash the caller last saw; omit only when deliberately overwriting. */
        baseHash: z.string().optional(),
      }),
      p,
    );
    const project = await projectOf(ctx.rt, projectId);
    return wrap(async () => {
      const written = await filesOf(ctx.rt, project).write(file, content, {
        ...(baseHash !== undefined && { baseHash }),
      });
      ctx.broadcast('workspace.changed', {
        projectId: project.id,
        path: written.path,
        reason: 'write',
      });
      return written;
    });
  },

  'workspace.file.create': async (p, ctx) => {
    const {
      projectId,
      path: file,
      kind,
      content,
    } = parse(
      ProjectRef.extend({
        path: z.string().min(1),
        kind: z.enum(['file', 'directory']).default('file'),
        content: z.string().default(''),
      }),
      p,
    );
    const project = await projectOf(ctx.rt, projectId);
    return wrap(async () => {
      const files = filesOf(ctx.rt, project);
      if (kind === 'directory') {
        await files.createDirectory(file);
      } else {
        await files.write(file, content, { createOnly: true });
      }
      ctx.broadcast('workspace.changed', { projectId: project.id, path: file, reason: 'create' });
      return { ok: true, path: file };
    });
  },

  'workspace.file.delete': async (p, ctx) => {
    const {
      projectId,
      path: file,
      recursive,
    } = parse(
      ProjectRef.extend({ path: z.string().min(1), recursive: z.boolean().default(false) }),
      p,
    );
    const project = await projectOf(ctx.rt, projectId);
    return wrap(async () => {
      await filesOf(ctx.rt, project).remove(file, { recursive });
      ctx.broadcast('workspace.changed', { projectId: project.id, path: file, reason: 'delete' });
      return { ok: true };
    });
  },

  'workspace.file.rename': async (p, ctx) => {
    const { projectId, from, to } = parse(
      ProjectRef.extend({ from: z.string().min(1), to: z.string().min(1) }),
      p,
    );
    const project = await projectOf(ctx.rt, projectId);
    return wrap(async () => {
      await filesOf(ctx.rt, project).rename(from, to);
      ctx.broadcast('workspace.changed', { projectId: project.id, path: to, reason: 'rename' });
      return { ok: true };
    });
  },

  'workspace.search': async (p, { rt }) => {
    const { projectId, query, maxResults } = parse(
      ProjectRef.extend({
        query: z.string().min(1).max(200),
        maxResults: z.number().int().min(1).max(1000).default(200),
      }),
      p,
    );
    const project = await projectOf(rt, projectId);
    return wrap(async () => ({ hits: await filesOf(rt, project).search(query, { maxResults }) }));
  },

  // ---- proposed changes ------------------------------------------------------------------------
  'changes.list': async (p, { rt }) => {
    const { projectId, all } = parse(ProjectRef.extend({ all: z.boolean().default(false) }), p);
    if (all) return { changes: await rt.changes.list() };
    const project = await projectOf(rt, projectId);
    return { changes: await rt.changes.list(project.id) };
  },

  'changes.get': async (p, { rt }) => {
    const { id, projectId } = parse(ProjectRef.extend({ id: z.string() }), p);
    const set = await wrap(() => rt.changes.get(id));
    const project = await projectOf(rt, projectId ?? set.projectId);
    return wrap(() => rt.changes.view(id, filesOf(rt, project)));
  },

  'changes.create': async (p, ctx) => {
    const { projectId, title, description, files } = parse(
      ProjectRef.extend({
        title: z.string().min(1).max(200),
        description: z.string().default(''),
        files: z
          .array(
            z.object({
              path: z.string().min(1),
              action: z.enum(['create', 'modify', 'delete']),
              content: z.string().optional(),
            }),
          )
          .min(1),
      }),
      p,
    );
    const project = await projectOf(ctx.rt, projectId);
    return wrap(async () => {
      const set = await ctx.rt.changes.create({
        projectId: project.id,
        title,
        description,
        origin: { kind: 'editor' },
        files,
        files_service: filesOf(ctx.rt, project),
      });
      ctx.broadcast('changes.changed', { id: set.id, projectId: project.id, reason: 'created' });
      return { change: set };
    });
  },

  'changes.decide': async (p, ctx) => {
    const { id, decision, paths } = parse(
      z.object({
        id: z.string(),
        decision: z.enum(['approved', 'rejected']),
        /** Omit to decide every file in the set. */
        paths: z.array(z.string()).optional(),
      }),
      p,
    );
    return wrap(async () => {
      const set = await ctx.rt.changes.decide(id, decision, paths);
      ctx.broadcast('changes.changed', { id, projectId: set.projectId, reason: decision });
      return { change: set };
    });
  },

  'changes.apply': async (p, ctx) => {
    const { id } = parse(z.object({ id: z.string() }), p);
    return wrap(async () => {
      const set = await ctx.rt.changes.get(id);
      const project = await projectOf(ctx.rt, set.projectId);
      const result = await ctx.rt.changes.apply(id, filesOf(ctx.rt, project));
      ctx.broadcast('changes.changed', { id, projectId: set.projectId, reason: 'applied' });
      for (const file of result.applied) {
        ctx.broadcast('workspace.changed', {
          projectId: set.projectId,
          path: file,
          reason: 'write',
        });
      }
      return result;
    });
  },

  'changes.remove': async (p, ctx) => {
    const { id } = parse(z.object({ id: z.string() }), p);
    const removed = await ctx.rt.changes.remove(id);
    ctx.broadcast('changes.changed', { id, reason: 'removed' });
    return { removed };
  },

  // ---- checkpoints -----------------------------------------------------------------------------
  'checkpoints.list': async (p, { rt }) => {
    const { projectId } = parse(ProjectRef, p);
    const project = await projectOf(rt, projectId);
    return { checkpoints: await rt.checkpoints.list(project.id) };
  },

  'checkpoints.create': async (p, ctx) => {
    const { projectId, name, reason } = parse(
      ProjectRef.extend({
        name: z.string().min(1).max(200),
        reason: z.string().max(80).default('manual'),
      }),
      p,
    );
    const project = await projectOf(ctx.rt, projectId);
    return wrap(async () => {
      const checkpoint = await ctx.rt.checkpoints.create({
        projectId: project.id,
        projectDir: project.path,
        name,
        reason,
      });
      ctx.broadcast('checkpoints.changed', {
        projectId: project.id,
        id: checkpoint.id,
        reason: 'created',
      });
      return { checkpoint };
    });
  },

  /** What a restore would change. Always call this before restoring; the UI shows it. */
  'checkpoints.preview': async (p, { rt }) => {
    const { id, projectId } = parse(ProjectRef.extend({ id: z.string() }), p);
    const project = await projectOf(rt, projectId);
    return wrap(() => rt.checkpoints.preview(id, project.path));
  },

  'checkpoints.restore': async (p, ctx) => {
    const { id, projectId, confirm } = parse(
      ProjectRef.extend({
        id: z.string(),
        /** Must be true: restoring changes files on disk, so it is never implicit. */
        confirm: z.boolean(),
      }),
      p,
    );
    if (!confirm) {
      throw new GatewayError('INVALID_REQUEST', 'Restoring needs an explicit confirmation.');
    }
    const project = await projectOf(ctx.rt, projectId);
    return wrap(async () => {
      const result = await ctx.rt.checkpoints.restore({
        id,
        projectId: project.id,
        projectDir: project.path,
      });
      ctx.broadcast('checkpoints.changed', { projectId: project.id, id, reason: 'restored' });
      ctx.broadcast('workspace.changed', { projectId: project.id, path: '.', reason: 'restore' });
      return result;
    });
  },

  'checkpoints.remove': async (p, ctx) => {
    const { id } = parse(z.object({ id: z.string() }), p);
    const removed = await ctx.rt.checkpoints.remove(id);
    ctx.broadcast('checkpoints.changed', { id, reason: 'removed' });
    return { removed };
  },

  // ---- MCP -------------------------------------------------------------------------------------
  'mcp.status': (_p, { rt }) => ({
    servers: rt.mcp.status(),
    tools: rt.mcp.tools(),
  }),

  'mcp.connect': async (p, ctx) => {
    const { id } = parse(z.object({ id: z.string() }), p);
    return wrap(async () => {
      const status = await ctx.rt.mcp.connect(id);
      ctx.broadcast('mcp.changed', { serverId: id, reason: status.state });
      return { server: status };
    });
  },

  'mcp.disconnect': async (p, ctx) => {
    const { id } = parse(z.object({ id: z.string() }), p);
    await ctx.rt.mcp.disconnect(id);
    ctx.broadcast('mcp.changed', { serverId: id, reason: 'disconnected' });
    return { ok: true };
  },

  /** Add or replace a server definition, then connect it. */
  'mcp.add': async (p, ctx) => {
    const server = parse(
      z.object({
        id: z
          .string()
          .min(1)
          .max(60)
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, 'Use letters, digits, dashes and underscores'),
        label: z.string().max(120).optional(),
        transport: z.enum(['stdio', 'http']).default('stdio'),
        command: z.string().optional(),
        args: z.array(z.string()).optional(),
        env: z.record(z.string(), z.string()).optional(),
        cwd: z.string().optional(),
        url: z.string().optional(),
        headers: z.record(z.string(), z.string()).optional(),
        trust: z.enum(['ask', 'allow']).default('ask'),
        enabled: z.boolean().default(true),
      }),
      p,
    );
    if (server.transport === 'stdio' && !server.command) {
      throw new GatewayError('INVALID_REQUEST', 'A stdio server needs a command to run.');
    }
    if (server.transport === 'http' && !server.url) {
      throw new GatewayError('INVALID_REQUEST', 'An HTTP server needs a url.');
    }
    const { id, ...rest } = server;
    await configWriteOrThrow(() => ctx.rt.config.patch({ mcp: { servers: { [id]: rest } } }));
    await ctx.rt.mcp.sync();
    ctx.broadcast('mcp.changed', { serverId: id, reason: 'added' });
    return { servers: ctx.rt.mcp.status() };
  },

  'mcp.remove': async (p, ctx) => {
    const { id } = parse(z.object({ id: z.string() }), p);
    await ctx.rt.mcp.disconnect(id);
    await configWriteOrThrow(() => ctx.rt.config.patch({ mcp: { servers: { [id]: null } } }));
    await ctx.rt.mcp.sync();
    ctx.broadcast('mcp.changed', { serverId: id, reason: 'removed' });
    return { removed: true };
  },

  /** Switch one tool on or off without touching the rest of the server. */
  'mcp.tool.set': async (p, ctx) => {
    const { id, tool, enabled } = parse(
      z.object({ id: z.string(), tool: z.string(), enabled: z.boolean() }),
      p,
    );
    const server = ctx.rt.cfg.mcp.servers[id];
    if (!server) throw new GatewayError('NOT_FOUND', `No MCP server called "${id}".`);
    const deny = new Set(server.tools.deny);
    if (enabled) deny.delete(tool);
    else deny.add(tool);
    await configWriteOrThrow(() =>
      ctx.rt.config.patch({ mcp: { servers: { [id]: { tools: { deny: [...deny] } } } } }),
    );
    ctx.broadcast('mcp.changed', { serverId: id, reason: 'tools' });
    return { tools: ctx.rt.mcp.tools() };
  },

  /** Call a tool straight from the UI, to check a server actually works. */
  'mcp.call': async (p, { rt }) => {
    const { id, tool, args } = parse(
      z.object({
        id: z.string(),
        tool: z.string(),
        args: z.record(z.string(), z.unknown()).default({}),
      }),
      p,
    );
    return wrap(async () => {
      const started = Date.now();
      const result = await rt.mcp.callTool(id, tool, args);
      return {
        isError: result.isError,
        text: renderToolResult(result),
        durationMs: Date.now() - started,
      };
    });
  },

  // ---- models --------------------------------------------------------------------------------
  /** What is installed and reachable on this machine, plus the keys configured for hosted APIs. */
  'models.detect': async (_p, { rt }) => {
    const providers = await detectLocalProviders();
    const configured = rt.cfg.models.providers;
    return {
      local: providers,
      hosted: [
        {
          id: 'anthropic',
          label: 'Anthropic',
          configured: Boolean(configured.anthropic?.apiKey || process.env.ANTHROPIC_API_KEY),
          source: configured.anthropic?.apiKey
            ? 'config'
            : process.env.ANTHROPIC_API_KEY
              ? 'environment'
              : null,
        },
        {
          id: 'openai',
          label: 'OpenAI',
          configured: Boolean(configured.openai?.apiKey || process.env.OPENAI_API_KEY),
          source: configured.openai?.apiKey
            ? 'config'
            : process.env.OPENAI_API_KEY
              ? 'environment'
              : null,
        },
      ],
      current: {
        primary: rt.cfg.agents.defaults.model.primary,
        fallbacks: rt.cfg.agents.defaults.model.fallbacks,
        thinking: rt.cfg.agents.defaults.thinkingDefault,
      },
    };
  },

  /** Ollama's own view of a model: context window, tool support, and what that means for us. */
  'models.inspect': async (p) => {
    const { model } = parse(z.object({ model: z.string().min(1) }), p);
    const name = model.startsWith('ollama/') ? model.slice('ollama/'.length) : model;
    return inspectOllamaModel(name);
  },

  /**
   * Actually run the model once. This is the only honest way to know a provider works, so the
   * wizard calls it before saving a choice.
   */
  'models.test': async (p, { rt }) => {
    const { model, prompt } = parse(
      z.object({
        model: z.string().min(1),
        prompt: z.string().max(400).default('Reply with the single word: ready'),
      }),
      p,
    );
    const started = Date.now();
    try {
      const result = await rt.testModel(model, prompt);
      return {
        ok: true,
        model,
        durationMs: Date.now() - started,
        text: result.text.slice(0, 500),
        usage: result.usage,
        toolCallingSupported: result.toolCallingSupported,
      };
    } catch (error) {
      return {
        ok: false,
        model,
        durationMs: Date.now() - started,
        error: (error as Error).message,
      };
    }
  },

  'models.use': async (p, ctx) => {
    const { primary, fallbacks } = parse(
      z.object({ primary: z.string().min(1), fallbacks: z.array(z.string()).optional() }),
      p,
    );
    await configWriteOrThrow(() =>
      ctx.rt.config.patch({
        agents: { defaults: { model: { primary, ...(fallbacks !== undefined && { fallbacks }) } } },
      }),
    );
    return {
      primary: ctx.rt.cfg.agents.defaults.model.primary,
      fallbacks: ctx.rt.cfg.agents.defaults.model.fallbacks,
    };
  },

  /** Store a provider API key in the config file (never echoed back to clients). */
  'models.credentials.set': async (p, ctx) => {
    const { provider, apiKey } = parse(
      z.object({ provider: z.enum(['anthropic', 'openai']), apiKey: z.string().max(400) }),
      p,
    );
    await configWriteOrThrow(() =>
      ctx.rt.config.patch({ models: { providers: { [provider]: { apiKey: apiKey || null } } } }),
    );
    return { provider, configured: Boolean(apiKey) };
  },

  // ---- telemetry -----------------------------------------------------------------------------
  'telemetry.summary': (p, { rt }) => {
    const { hours, sessionKey } = parse(
      z.object({
        hours: z.number().int().min(1).max(720).default(24),
        sessionKey: z.string().optional(),
      }),
      p,
    );
    return rt.telemetry.summary({
      since: Date.now() - hours * 3_600_000,
      ...(sessionKey !== undefined && { sessionKey }),
    });
  },

  'telemetry.runs': (p, { rt }) => {
    const { model, sessionKey, limit, hours } = parse(
      z.object({
        model: z.string().optional(),
        sessionKey: z.string().optional(),
        limit: z.number().int().min(1).max(1000).default(100),
        hours: z.number().int().min(1).max(720).optional(),
      }),
      p,
    );
    return {
      runs: rt.telemetry.list({
        ...(model !== undefined && { model }),
        ...(sessionKey !== undefined && { sessionKey }),
        ...(hours !== undefined && { since: Date.now() - hours * 3_600_000 }),
        limit,
      }),
    };
  },

  // ---- tests ---------------------------------------------------------------------------------
  'tests.detect': async (p, { rt }) => {
    const { projectId } = parse(ProjectRef, p);
    const project = await projectOf(rt, projectId);
    return { suites: await detectTestSuites(project.path) };
  },

  /**
   * Run one of the suites detection found. Suites are chosen by id rather than accepting a
   * command, so this cannot be used to run arbitrary programs.
   */
  'tests.run': async (p, { rt }) => {
    const { projectId, suiteId, wait } = parse(
      ProjectRef.extend({ suiteId: z.string(), wait: z.boolean().default(false) }),
      p,
    );
    const project = await projectOf(rt, projectId);
    if (rt.cfg.security.mode === 'read-only') {
      throw new GatewayError(
        'FORBIDDEN',
        'Running tests executes project code, which read-only mode does not allow.',
      );
    }
    const suite = (await detectTestSuites(project.path)).find((s) => s.id === suiteId);
    if (!suite)
      throw new GatewayError('NOT_FOUND', `No test suite "${suiteId}" in ${project.name}.`);
    if (!suite.available)
      throw new GatewayError(
        'INVALID_REQUEST',
        suite.reason ?? `${suite.command} is not installed.`,
      );

    const running = rt.tests.run({ projectId: project.id, projectDir: project.path, suite });
    if (wait) return { run: await running };
    // Streamed through tests.output / tests.finished events.
    const started = rt.tests.history(project.id, 1)[0];
    return { run: started };
  },

  'tests.cancel': (p, { rt }) => {
    const { runId } = parse(z.object({ runId: z.string() }), p);
    return { cancelled: rt.tests.cancel(runId) };
  },

  'tests.history': async (p, { rt }) => {
    const { projectId, limit } = parse(
      ProjectRef.extend({ limit: z.number().int().min(1).max(50).default(20) }),
      p,
    );
    const project = await projectOf(rt, projectId);
    return {
      runs: rt.tests
        .history(project.id, limit)
        .map(({ output, ...rest }) => ({ ...rest, outputBytes: output.length })),
    };
  },

  'tests.get': (p, { rt }) => {
    const { runId } = parse(z.object({ runId: z.string() }), p);
    const run = rt.tests.get(runId);
    if (!run) throw new GatewayError('NOT_FOUND', `No test run ${runId}`);
    return { run };
  },

  /**
   * Hand a real failure to the agent and ask for a fix as a reviewable change. The result lands in
   * Changes for approval; nothing is written until the developer approves it.
   */
  'tests.fix': async (p, { rt }) => {
    const { runId } = parse(z.object({ runId: z.string() }), p);
    const run = rt.tests.get(runId);
    if (!run) throw new GatewayError('NOT_FOUND', `No test run ${runId}`);
    if (run.status !== 'failed')
      throw new GatewayError('INVALID_REQUEST', 'Only a failed run can be sent for a fix.');
    const project = await projectOf(rt, run.projectId);

    const failures = run.failures.length
      ? run.failures.map((f) => `- ${f.name}\n${f.detail}`).join('\n\n')
      : '(no individual failures could be parsed; see the output below)';
    const message = [
      `The test command \`${run.command}\` failed in the project "${project.name}" (${project.path}), exit code ${run.exitCode ?? 'unknown'}.`,
      '',
      'Failures parsed from the output:',
      failures,
      '',
      'Last part of the output:',
      '```',
      run.output.slice(-6000),
      '```',
      '',
      'Read the relevant files, find the cause, and propose a fix with the propose_change tool so the developer can review it. Do not write files directly. Explain the cause in one or two sentences.',
    ].join('\n');

    const sessionKey = `agent:${rt.agentId}:tests:${project.id}`;
    await rt.sessions.ensure(sessionKey);
    const result = await rt.agent.dispatch({
      sessionKey,
      message,
      source: { kind: 'user', channel: 'webchat', senderName: 'Test runner' },
    });
    return { sessionKey, runId: result.runId, status: result.status };
  },

  // ---- debugger ------------------------------------------------------------------------------
  'debug.runs': (p, { rt }) => {
    const { sessionKey, status, limit } = parse(
      z.object({
        sessionKey: z.string().optional(),
        status: z.enum(['running', 'ok', 'error', 'aborted']).optional(),
        limit: z.number().int().min(1).max(200).default(50),
      }),
      p,
    );
    return {
      runs: rt.traces.list({
        ...(sessionKey !== undefined && { sessionKey: rt.canonical(sessionKey) }),
        ...(status !== undefined && { status }),
        limit,
      }),
    };
  },

  'debug.trace': (p, { rt }) => {
    const { runId } = parse(z.object({ runId: z.string() }), p);
    const trace = rt.traces.get(runId);
    if (!trace)
      throw new GatewayError(
        'NOT_FOUND',
        `No trace for run ${runId}. Traces are kept for the most recent 200 runs.`,
      );
    return { trace };
  },

  /** Sanitized, self-contained export of one run or a whole session. */
  'debug.export': (p, { rt }) => {
    const { runId, sessionKey } = parse(
      z.object({ runId: z.string().optional(), sessionKey: z.string().optional() }),
      p,
    );
    if (!runId && !sessionKey)
      throw new GatewayError('INVALID_REQUEST', 'Pass a runId or a sessionKey.');
    return rt.traces.export({
      ...(runId !== undefined && { runId }),
      ...(sessionKey !== undefined && { sessionKey: rt.canonical(sessionKey) }),
    });
  },

  /** Sanitized diagnostics bundle: versions, config shape, health, recent errors and traces. */
  'debug.diagnostics': async (_p, { rt }) => {
    const secrets = rt.knownSecrets();
    const logs = await rt.logs.tail({ limit: 200 });
    const errors = logs.lines
      .map((line) => {
        try {
          return JSON.parse(line) as { level?: string };
        } catch {
          return undefined;
        }
      })
      .filter((record) => record?.level === 'error' || record?.level === 'warn');
    return sanitizeValue(
      {
        generatedAt: new Date().toISOString(),
        runtime: { node: process.version, platform: process.platform, arch: process.arch },
        gateway: {
          stateDir: rt.paths.stateDir,
          workspace: rt.workspaceDir,
          startedAt: rt.startedAt,
        },
        config: { valid: rt.config.get().valid, issues: rt.config.get().issues, config: rt.cfg },
        security: rt.fsPolicy.describe(),
        mcp: rt.mcp.status(),
        telemetry: rt.telemetry.summary({ since: Date.now() - 24 * 3_600_000 }),
        recentProblems: errors.slice(-50),
        recentRuns: rt.traces.list({ limit: 20 }),
      },
      secrets,
    );
  },

  // ---- skills registry -----------------------------------------------------------------------
  /** Full detail for one skill: instructions, requirements, scripts, where it came from. */
  'skills.inspect': async (p, { rt }) => {
    const { name } = parse(z.object({ name: z.string().min(1) }), p);
    const { skills } = await rt.loadAllSkills();
    const skill = skills.find((s) => s.name === name);
    if (!skill) throw new GatewayError('NOT_FOUND', `No skill called "${name}".`);
    const status = (await rt.skillStatus()).find((s) => s.name === name);
    const validation = await registryOf(rt).validate(skill.baseDir);
    return {
      skill: {
        name: skill.name,
        description: skill.description,
        source: skill.source,
        baseDir: skill.baseDir,
        filePath: skill.filePath,
        homepage: skill.homepage,
        userInvocable: skill.userInvocable,
        requires: skill.metadata.requires ?? {},
        instructions: skill.body,
      },
      status,
      scripts: validation.executables,
      warnings: validation.warnings,
      origin: await registryOf(rt).origin(name),
    };
  },

  'skills.validate': async (p, { rt }) => {
    const { path: dir } = parse(z.object({ path: z.string().min(1) }), p);
    return registryOf(rt).validate(path.resolve(dir));
  },

  'skills.install': async (p, ctx) => {
    const input = parse(
      z.discriminatedUnion('from', [
        z.object({
          from: z.literal('local'),
          path: z.string().min(1),
          overwrite: z.boolean().default(false),
        }),
        z.object({
          from: z.literal('git'),
          url: z.string().min(1).max(500),
          subdir: z.string().optional(),
          branch: z.string().optional(),
          overwrite: z.boolean().default(false),
        }),
      ]),
      p,
    );
    return wrap(async () => {
      const registry = registryOf(ctx.rt);
      const installed =
        input.from === 'local'
          ? await registry.importLocal(path.resolve(input.path), { overwrite: input.overwrite })
          : await registry.installFromGit(input.url, {
              overwrite: input.overwrite,
              ...(input.subdir !== undefined && { subdir: input.subdir }),
              ...(input.branch !== undefined && { branch: input.branch }),
            });
      ctx.rt.log.info(`skill installed: ${installed.name}`, { from: input.from });
      ctx.broadcast('skills.changed', { name: installed.name, reason: 'installed' });
      return { installed, validation: await registry.validate(installed.dir) };
    });
  },

  'skills.create': async (p, ctx) => {
    const { name, description, where } = parse(
      z.object({
        name: z.string().min(1),
        description: z.string().min(1).max(400),
        where: z.enum(['workspace', 'managed']).default('workspace'),
      }),
      p,
    );
    return wrap(async () => {
      const created = await registryOf(ctx.rt).create({ name, description, where });
      ctx.broadcast('skills.changed', { name, reason: 'created' });
      return { created };
    });
  },

  'skills.remove': async (p, ctx) => {
    const { name } = parse(z.object({ name: z.string().min(1) }), p);
    return wrap(async () => {
      const result = await registryOf(ctx.rt).remove(name);
      ctx.broadcast('skills.changed', { name, reason: 'removed' });
      return result;
    });
  },

  'skills.upgrade': async (p, ctx) => {
    const { name } = parse(z.object({ name: z.string().min(1) }), p);
    return wrap(async () => {
      const updated = await registryOf(ctx.rt).update(name);
      ctx.broadcast('skills.changed', { name, reason: 'updated' });
      return { updated };
    });
  },

  // ---- multi-agent workflows -----------------------------------------------------------------
  'workflows.list': (_p, { rt }) => ({
    roles: rt.workflows.listRoles(),
    workflows: rt.workflows.listWorkflows(),
  }),

  'workflows.role.save': async (p, { rt }) =>
    wrap(async () => ({ role: await rt.workflows.saveRole(p) })),

  'workflows.role.remove': async (p, { rt }) => {
    const { id } = parse(z.object({ id: z.string() }), p);
    return wrap(async () => ({ removed: await rt.workflows.removeRole(id) }));
  },

  'workflows.save': async (p, { rt }) =>
    wrap(async () => ({ workflow: await rt.workflows.saveWorkflow(p) })),

  'workflows.remove': async (p, { rt }) => {
    const { id } = parse(z.object({ id: z.string() }), p);
    return wrap(async () => ({ removed: await rt.workflows.removeWorkflow(id) }));
  },

  'workflows.start': async (p, { rt }) => {
    const { workflowId, request } = parse(
      z.object({ workflowId: z.string(), request: z.string().min(1).max(8000) }),
      p,
    );
    return wrap(async () => ({ execution: await rt.workflows.start(workflowId, request) }));
  },

  'workflows.cancel': async (p, { rt }) => {
    const { id } = parse(z.object({ id: z.string() }), p);
    return wrap(async () => ({ execution: await rt.workflows.cancel(id) }));
  },

  'workflows.executions': (p, { rt }) => {
    const { limit } = parse(z.object({ limit: z.number().int().min(1).max(100).default(30) }), p);
    return { executions: rt.workflows.executionsList(limit) };
  },

  'workflows.execution': (p, { rt }) => {
    const { id } = parse(z.object({ id: z.string() }), p);
    const execution = rt.workflows.execution(id);
    if (!execution) throw new GatewayError('NOT_FOUND', `No workflow run ${id}.`);
    return { execution };
  },

  // ---- tools ---------------------------------------------------------------------------------
  /** The tools an agent run would get right now, after config, security mode and MCP. */
  'tools.list': (_p, { rt }) => {
    const tools = buildTools({ config: rt.cfg, browser: rt.browser, mcp: rt.mcp });
    return {
      securityMode: rt.cfg.security.mode,
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        source: tool.name.startsWith('mcp__') ? 'mcp' : 'builtin',
        inputSchema: tool.inputSchema,
      })),
    };
  },

  // ---- git -------------------------------------------------------------------------------------
  'git.available': async () => gitAvailable(),

  'git.status': async (p, { rt }) => {
    const { projectId } = parse(ProjectRef, p);
    const project = await projectOf(rt, projectId);
    const repo = repoOf(project);
    if (!(await repo.isRepo())) {
      return { isRepo: false, project: { id: project.id, name: project.name, path: project.path } };
    }
    return wrap(async () => ({
      isRepo: true,
      project: { id: project.id, name: project.name, path: project.path },
      status: await repo.status(),
      remotes: await repo.remotes(),
    }));
  },

  'git.branches': async (p, { rt }) => {
    const { projectId, includeRemote } = parse(
      ProjectRef.extend({ includeRemote: z.boolean().default(true) }),
      p,
    );
    const project = await projectOf(rt, projectId);
    return wrap(async () => ({ branches: await repoOf(project).branches(includeRemote) }));
  },

  'git.log': async (p, { rt }) => {
    const { projectId, limit, ref } = parse(
      ProjectRef.extend({
        limit: z.number().int().min(1).max(500).default(30),
        ref: z.string().optional(),
      }),
      p,
    );
    const project = await projectOf(rt, projectId);
    return wrap(async () => ({ commits: await repoOf(project).log(limit, ref) }));
  },

  'git.diff': async (p, { rt }) => {
    const { projectId, file, staged, contextLines } = parse(
      ProjectRef.extend({
        file: z.string().optional(),
        staged: z.boolean().default(false),
        contextLines: z.number().int().min(0).max(20).default(3),
      }),
      p,
    );
    const project = await projectOf(rt, projectId);
    const repo = repoOf(project);
    return wrap(async () => ({
      diff: file
        ? await repo.diffFile(file, { staged })
        : await repo.diff({ staged, contextLines }),
    }));
  },

  'git.show': async (p, { rt }) => {
    const { projectId, ref, file } = parse(
      ProjectRef.extend({ ref: z.string().min(1), file: z.string().min(1) }),
      p,
    );
    const project = await projectOf(rt, projectId);
    return wrap(async () => ({ content: await repoOf(project).show(ref, file) }));
  },

  'git.checkout': async (p, ctx) => {
    const { projectId, branch, create } = parse(
      ProjectRef.extend({ branch: z.string().min(1).max(200), create: z.boolean().default(false) }),
      p,
    );
    const project = await projectOf(ctx.rt, projectId);
    const repo = repoOf(project);
    return wrap(async () => {
      // Switching with uncommitted work risks losing it; say so instead of letting git guess.
      const before = await repo.status();
      if (!before.clean && !create) {
        const names = before.files
          .slice(0, 5)
          .map((f) => f.path)
          .join(', ');
        throw new GatewayError(
          'CONFLICT',
          `There are uncommitted changes (${names}${before.files.length > 5 ? '…' : ''}). Commit, stash or discard them before switching branches.`,
        );
      }
      await repo.checkout(branch, { create });
      ctx.broadcast('projects.changed', { reason: 'branch', id: project.id });
      return { branch: await repo.currentBranch() };
    });
  },

  'git.fetch': async (p, { rt }) => {
    const { projectId } = parse(ProjectRef, p);
    const project = await projectOf(rt, projectId);
    return wrap(async () => ({ output: await repoOf(project).fetch() }));
  },

  'git.commit': async (p, ctx) => {
    const { projectId, message, files } = parse(
      ProjectRef.extend({
        message: z.string().min(1).max(4000),
        files: z.array(z.string()).default([]),
      }),
      p,
    );
    const project = await projectOf(ctx.rt, projectId);
    const repo = repoOf(project);
    return wrap(async () => {
      if (files.length > 0) await repo.add(files);
      const hash = await repo.commit(message);
      ctx.broadcast('projects.changed', { reason: 'commit', id: project.id });
      return { hash };
    });
  },

  'git.clone': async (p, ctx) => {
    const { url, directory, name, branch, depth } = parse(
      z.object({
        url: z.string().min(1).max(500),
        /** Where to put the clone. Must be inside a directory the policy already allows. */
        directory: z.string().min(1),
        name: z.string().optional(),
        branch: z.string().optional(),
        depth: z.number().int().min(1).max(1000).optional(),
      }),
      p,
    );
    const target = path.resolve(directory);
    const parent = path.dirname(target);
    const allowed = ctx.rt.fsPolicy.canWrite(parent);
    if (!allowed.allowed) {
      throw new GatewayError(
        'FORBIDDEN',
        `${parent} is outside the allowed workspace. Add it under Security first, or clone into an existing project folder.`,
      );
    }
    return wrap(async () => {
      await gitClone(url, target, {
        ...(branch !== undefined && { branch }),
        ...(depth !== undefined && { depth }),
      });
      const project = await ctx.rt.projects.add({
        path: target,
        ...(name !== undefined && { name }),
      });
      await ctx.rt.refreshFsPolicy();
      ctx.broadcast('projects.changed', { reason: 'clone', id: project.id });
      return { project };
    });
  },
};

/** Config writes raise ConfigError; surface the reason instead of a stack trace. */
async function configWriteOrThrow<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new GatewayError('INVALID_REQUEST', (error as Error).message);
  }
}
