import path from 'node:path';
import { z } from 'zod';
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
