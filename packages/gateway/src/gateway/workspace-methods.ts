import path from 'node:path';
import { z } from 'zod';
import { ChangeError } from '../changes/proposals.js';
import { CheckpointError } from '../checkpoints/service.js';
import { McpError, renderToolResult } from '../mcp/client.js';
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
