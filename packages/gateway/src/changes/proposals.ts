import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { FileService } from '../workspace/file-service.js';
import { FileServiceError, hashOf } from '../workspace/file-service.js';
import { readTextOr, writeFileAtomic } from '../util/fs.js';
import { diffStat, unifiedDiff } from './diff.js';

export const ChangeFileSchema = z.object({
  path: z.string().min(1),
  action: z.enum(['create', 'modify', 'delete']),
  /** Proposed contents; absent for a deletion. */
  content: z.string().optional(),
  /** Hash of the file when the change was proposed; used to detect a stale patch. */
  baseHash: z.string().optional(),
  status: z.enum(['pending', 'approved', 'rejected', 'applied', 'failed']).default('pending'),
  /** Why an apply failed, or why a file is stale. */
  note: z.string().optional(),
  additions: z.number().default(0),
  deletions: z.number().default(0),
});

export const ChangeSetSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string().min(1).max(200),
  description: z.string().default(''),
  createdAt: z.number(),
  updatedAt: z.number(),
  status: z.enum(['pending', 'applied', 'partial', 'rejected']).default('pending'),
  origin: z
    .object({
      kind: z.enum(['agent', 'editor', 'workflow', 'operator']).default('agent'),
      sessionKey: z.string().optional(),
      runId: z.string().optional(),
      agentRole: z.string().optional(),
    })
    .default({ kind: 'agent' }),
  files: z.array(ChangeFileSchema).default([]),
});

export type ChangeFile = z.output<typeof ChangeFileSchema>;
export type ChangeSet = z.output<typeof ChangeSetSchema>;

export interface ChangeFileView extends ChangeFile {
  /** Unified diff against what is on disk right now. */
  diff: string;
  /** True when the file changed since the proposal was made. */
  stale: boolean;
  /** Contents on disk now, for side-by-side review. */
  current?: string;
}

export interface ChangeSetView extends Omit<ChangeSet, 'files'> {
  files: ChangeFileView[];
  stats: { additions: number; deletions: number; files: number };
}

export interface ApplyResult {
  id: string;
  applied: string[];
  skipped: { path: string; reason: string }[];
  status: ChangeSet['status'];
}

export class ChangeError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'INVALID' | 'CONFLICT',
    message: string,
  ) {
    super(message);
    this.name = 'ChangeError';
  }
}

/**
 * Proposed edits waiting for a human decision.
 *
 * A proposal records the file contents the agent wants and the hash it based them on. Nothing
 * reaches the working tree until someone approves it, and an approval only applies when the file
 * still looks the way it did when the change was proposed — so a stale patch surfaces as a conflict
 * instead of quietly reverting newer work.
 */
export class ChangeStore {
  constructor(readonly dir: string) {}

  private file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  async list(projectId?: string): Promise<ChangeSet[]> {
    await fsp.mkdir(this.dir, { recursive: true });
    const names = await fsp.readdir(this.dir).catch(() => [] as string[]);
    const sets: ChangeSet[] = [];
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      const parsed = ChangeSetSchema.safeParse(
        JSON.parse((await readTextOr(path.join(this.dir, name), '{}')) || '{}'),
      );
      if (parsed.success && (!projectId || parsed.data.projectId === projectId))
        sets.push(parsed.data);
    }
    return sets.sort((a, b) => b.createdAt - a.createdAt);
  }

  async get(id: string): Promise<ChangeSet> {
    const raw = await readTextOr(this.file(id), '');
    if (!raw) throw new ChangeError('NOT_FOUND', `No change set ${id}`);
    const parsed = ChangeSetSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new ChangeError('INVALID', `Change set ${id} is unreadable`);
    return parsed.data;
  }

  /** Record a proposal. Content hashes are taken now, so staleness is measured from this moment. */
  async create(input: {
    projectId: string;
    title: string;
    description?: string;
    origin?: ChangeSet['origin'];
    files: { path: string; action: ChangeFile['action']; content?: string }[];
    files_service: FileService;
  }): Promise<ChangeSet> {
    if (input.files.length === 0)
      throw new ChangeError('INVALID', 'A change set needs at least one file.');

    const files: ChangeFile[] = [];
    for (const file of input.files) {
      const before = await readCurrent(input.files_service, file.path);
      if (file.action !== 'delete' && file.content === undefined) {
        throw new ChangeError('INVALID', `No content supplied for ${file.path}`);
      }
      if (file.action === 'modify' && before === undefined) {
        throw new ChangeError('INVALID', `${file.path} does not exist, so it cannot be modified.`);
      }
      if (file.action === 'create' && before !== undefined) {
        throw new ChangeError('INVALID', `${file.path} already exists; propose a modify instead.`);
      }
      const after = file.action === 'delete' ? '' : (file.content ?? '');
      const stat = diffStat(before ?? '', after);
      files.push({
        path: file.path,
        action: file.action,
        ...(file.action !== 'delete' && { content: after }),
        ...(before !== undefined && { baseHash: hashOf(Buffer.from(before, 'utf8')) }),
        status: 'pending',
        additions: stat.additions,
        deletions: stat.deletions,
      });
    }

    const now = Date.now();
    const set: ChangeSet = {
      id: randomUUID(),
      projectId: input.projectId,
      title: input.title.slice(0, 200),
      description: input.description ?? '',
      createdAt: now,
      updatedAt: now,
      status: 'pending',
      origin: input.origin ?? { kind: 'agent' },
      files,
    };
    await this.save(set);
    return set;
  }

  /** A change set with fresh diffs against the working tree, and staleness worked out. */
  async view(id: string, files: FileService): Promise<ChangeSetView> {
    const set = await this.get(id);
    const views: ChangeFileView[] = [];
    for (const file of set.files) {
      const current = await readCurrent(files, file.path);
      const currentHash = current === undefined ? undefined : hashOf(Buffer.from(current, 'utf8'));
      const stale =
        file.status === 'applied' ? false : (file.baseHash ?? undefined) !== currentHash;
      const after = file.action === 'delete' ? '' : (file.content ?? '');
      views.push({
        ...file,
        diff: unifiedDiff(current ?? '', after, { path: file.path }),
        stale,
        ...(current !== undefined && { current }),
      });
    }
    return {
      ...set,
      files: views,
      stats: {
        files: views.length,
        additions: views.reduce((sum, f) => sum + f.additions, 0),
        deletions: views.reduce((sum, f) => sum + f.deletions, 0),
      },
    };
  }

  /** Mark files approved or rejected. Passing no paths decides the whole set. */
  async decide(
    id: string,
    decision: 'approved' | 'rejected',
    paths?: string[],
  ): Promise<ChangeSet> {
    const set = await this.get(id);
    for (const file of set.files) {
      if (file.status === 'applied') continue;
      if (paths && !paths.includes(file.path)) continue;
      file.status = decision;
    }
    if (set.files.every((f) => f.status === 'rejected')) set.status = 'rejected';
    set.updatedAt = Date.now();
    await this.save(set);
    return set;
  }

  /**
   * Write the approved files. Each one is re-checked against its base hash first: a file that
   * changed since the proposal is skipped with a reason, never overwritten.
   */
  async apply(id: string, files: FileService): Promise<ApplyResult> {
    const set = await this.get(id);
    const applied: string[] = [];
    const skipped: { path: string; reason: string }[] = [];

    for (const file of set.files) {
      if (file.status === 'applied') continue;
      if (file.status !== 'approved') {
        skipped.push({
          path: file.path,
          reason: file.status === 'rejected' ? 'rejected' : 'not approved yet',
        });
        continue;
      }

      const current = await readCurrent(files, file.path);
      const currentHash = current === undefined ? undefined : hashOf(Buffer.from(current, 'utf8'));
      if ((file.baseHash ?? undefined) !== currentHash) {
        file.status = 'failed';
        file.note = 'The file changed after this was proposed; review it again.';
        skipped.push({ path: file.path, reason: file.note });
        continue;
      }

      try {
        if (file.action === 'delete') await files.remove(file.path);
        else await files.write(file.path, file.content ?? '', { baseHash: file.baseHash ?? '' });
        file.status = 'applied';
        delete file.note;
        applied.push(file.path);
      } catch (error) {
        file.status = 'failed';
        file.note = error instanceof FileServiceError ? error.message : (error as Error).message;
        skipped.push({ path: file.path, reason: file.note });
      }
    }

    const anyApplied = set.files.some((f) => f.status === 'applied');
    const anyOutstanding = set.files.some(
      (f) => f.status === 'pending' || f.status === 'approved' || f.status === 'failed',
    );
    set.status = anyApplied && anyOutstanding ? 'partial' : anyApplied ? 'applied' : set.status;
    set.updatedAt = Date.now();
    await this.save(set);

    return { id, applied, skipped, status: set.status };
  }

  async remove(id: string): Promise<boolean> {
    try {
      await fsp.rm(this.file(id));
      return true;
    } catch {
      return false;
    }
  }

  private async save(set: ChangeSet): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
    await writeFileAtomic(this.file(set.id), `${JSON.stringify(set, null, 2)}\n`);
  }
}

/** Current contents, or undefined when the file does not exist. Other errors propagate. */
async function readCurrent(files: FileService, relative: string): Promise<string | undefined> {
  try {
    return (await files.read(relative)).content;
  } catch (error) {
    if (error instanceof FileServiceError && error.code === 'NOT_FOUND') return undefined;
    throw error;
  }
}
