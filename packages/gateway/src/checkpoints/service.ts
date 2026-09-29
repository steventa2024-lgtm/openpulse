import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { GitRepo } from '../git/git.js';
import { readTextOr, writeFileAtomic } from '../util/fs.js';

export const CheckpointSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string().min(1).max(200),
  createdAt: z.number(),
  /** How the snapshot was stored. */
  kind: z.enum(['git', 'copy']),
  /** git: the commit object holding the snapshot. copy: the directory under the state dir. */
  ref: z.string(),
  /** Branch and HEAD at the time, so a restore can explain where it came from. */
  branch: z.string().optional(),
  head: z.string().optional(),
  /** What the checkpoint was taken for: a task, a workflow, a manual save. */
  reason: z.string().default('manual'),
  fileCount: z.number().default(0),
  bytes: z.number().default(0),
  note: z.string().optional(),
});

export type Checkpoint = z.output<typeof CheckpointSchema>;

export interface RestorePreviewEntry {
  path: string;
  /** What restoring would do to this file. */
  action: 'restore' | 'delete' | 'unchanged';
  reason?: string;
}

export interface RestorePreview {
  checkpoint: Checkpoint;
  entries: RestorePreviewEntry[];
  /** Files that exist now but not in the checkpoint; restoring removes them. */
  removals: number;
  changes: number;
}

export class CheckpointError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'UNSUPPORTED' | 'FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'CheckpointError';
  }
}

/** Directories never worth snapshotting. */
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'target',
  '.next',
  '.turbo',
  '.venv',
  '__pycache__',
]);
const MAX_COPY_FILES = 20_000;
const MAX_COPY_BYTES = 512 * 1024 * 1024;

/**
 * Point-in-time snapshots of a project, including work that was never committed.
 *
 * In a git repository the snapshot is written as real git objects through a scratch index, so the
 * working tree, the index and untracked files are all captured without touching the developer's
 * index, branch or stash. Projects without git fall back to a file copy.
 *
 * Restoring is deliberately two-step: ask for a preview, show what would change, then confirm. A
 * fresh checkpoint is always taken first, so a rollback can itself be rolled back.
 */
export class CheckpointService {
  constructor(
    readonly dir: string,
    private readonly options: { maxPerProject?: number } = {},
  ) {}

  private indexFile(): string {
    return path.join(this.dir, 'index.json');
  }

  async list(projectId?: string): Promise<Checkpoint[]> {
    const raw = await readTextOr(this.indexFile(), '');
    if (!raw) return [];
    const parsed = z.array(CheckpointSchema).safeParse(JSON.parse(raw));
    const all = parsed.success ? parsed.data : [];
    return all
      .filter((c) => !projectId || c.projectId === projectId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async get(id: string): Promise<Checkpoint> {
    const found = (await this.list()).find((c) => c.id === id);
    if (!found) throw new CheckpointError('NOT_FOUND', `No checkpoint ${id}`);
    return found;
  }

  /** Take a snapshot of `projectDir`, including uncommitted and untracked work. */
  async create(input: {
    projectId: string;
    projectDir: string;
    name: string;
    reason?: string;
  }): Promise<Checkpoint> {
    const repo = new GitRepo(input.projectDir);
    const isRepo = await repo.isRepo();
    const id = randomUUID();

    const checkpoint: Checkpoint = isRepo
      ? await this.snapshotGit(id, input, repo)
      : await this.snapshotCopy(id, input);

    const all = await this.list();
    all.unshift(checkpoint);
    await this.writeIndex(await this.prune(all, input.projectId));
    return checkpoint;
  }

  /** What restoring would do, without doing it. */
  async preview(id: string, projectDir: string): Promise<RestorePreview> {
    const checkpoint = await this.get(id);
    const entries: RestorePreviewEntry[] = [];

    if (checkpoint.kind === 'git') {
      const repo = new GitRepo(projectDir);
      // Compare the snapshot commit with the working tree, including untracked files.
      const output = await repo.git(['diff', '--name-status', '--no-renames', checkpoint.ref]);
      for (const line of output.split('\n').filter(Boolean)) {
        const [status = '', file = ''] = line.split('\t');
        if (!file) continue;
        // Git reports the diff from the snapshot to now: "A" means the file appeared since.
        entries.push({
          path: file,
          action: status.startsWith('A') ? 'delete' : 'restore',
          reason: status.startsWith('A')
            ? 'added after the checkpoint'
            : 'differs from the checkpoint',
        });
      }
      const untracked = await repo.git(['ls-files', '--others', '--exclude-standard']);
      for (const file of untracked.split('\n').filter(Boolean)) {
        if (!entries.some((entry) => entry.path === file)) {
          entries.push({ path: file, action: 'delete', reason: 'created after the checkpoint' });
        }
      }
    } else {
      const snapshot = await listFiles(path.join(this.dir, checkpoint.ref, 'tree'));
      const current = await listFiles(projectDir);
      for (const file of new Set([...snapshot.keys(), ...current.keys()])) {
        const inSnapshot = snapshot.get(file);
        const now = current.get(file);
        if (inSnapshot === undefined)
          entries.push({ path: file, action: 'delete', reason: 'created after the checkpoint' });
        else if (now === undefined)
          entries.push({ path: file, action: 'restore', reason: 'deleted since the checkpoint' });
        else if (now !== inSnapshot)
          entries.push({ path: file, action: 'restore', reason: 'changed since the checkpoint' });
      }
    }

    entries.sort((a, b) => a.path.localeCompare(b.path));
    return {
      checkpoint,
      entries,
      removals: entries.filter((e) => e.action === 'delete').length,
      changes: entries.filter((e) => e.action === 'restore').length,
    };
  }

  /**
   * Restore a checkpoint. A "before rollback" checkpoint is taken first, so the state being
   * replaced is itself recoverable.
   */
  async restore(input: {
    id: string;
    projectId: string;
    projectDir: string;
  }): Promise<{ restored: RestorePreview; safety: Checkpoint }> {
    const preview = await this.preview(input.id, input.projectDir);
    const checkpoint = preview.checkpoint;

    const safety = await this.create({
      projectId: input.projectId,
      projectDir: input.projectDir,
      name: `Before restoring "${checkpoint.name}"`,
      reason: 'pre-restore',
    });

    if (checkpoint.kind === 'git') {
      const repo = new GitRepo(input.projectDir);
      // Put the snapshot's tree into the working copy, then remove what it never contained.
      await repo.git(['-c', 'core.autocrlf=false', 'checkout', checkpoint.ref, '--', '.']);
      for (const entry of preview.entries.filter((e) => e.action === 'delete')) {
        await fsp
          .rm(path.join(input.projectDir, entry.path), { force: true })
          .catch(() => undefined);
      }
    } else {
      const treeDir = path.join(this.dir, checkpoint.ref, 'tree');
      for (const entry of preview.entries) {
        const target = path.join(input.projectDir, entry.path);
        if (entry.action === 'delete') {
          await fsp.rm(target, { force: true }).catch(() => undefined);
          continue;
        }
        const source = path.join(treeDir, entry.path);
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.copyFile(source, target).catch(() => undefined);
      }
    }

    return { restored: preview, safety };
  }

  async remove(id: string): Promise<boolean> {
    const all = await this.list();
    const checkpoint = all.find((c) => c.id === id);
    if (!checkpoint) return false;
    if (checkpoint.kind === 'copy') {
      await fsp
        .rm(path.join(this.dir, checkpoint.ref), { recursive: true, force: true })
        .catch(() => undefined);
    }
    await this.writeIndex(all.filter((c) => c.id !== id));
    return true;
  }

  // -----------------------------------------------------------------------------------------------

  private async snapshotGit(
    id: string,
    input: { projectId: string; projectDir: string; name: string; reason?: string },
    repo: GitRepo,
  ): Promise<Checkpoint> {
    const scratchIndex = path.join(this.dir, `${id}.index`);
    await fsp.mkdir(this.dir, { recursive: true });
    const env = { GIT_INDEX_FILE: scratchIndex };

    try {
      // A scratch index keeps the developer's staged work exactly as it was, and line-ending
      // translation is switched off so a snapshot restores the exact bytes that were there.
      await repo.git(['-c', 'core.autocrlf=false', 'add', '--all', '--'], { env });
      const tree = (await repo.git(['write-tree'], { env })).trim();
      const head = await repo
        .git(['rev-parse', 'HEAD'])
        .then((h) => h.trim())
        .catch(() => '');
      const commitArgs = ['commit-tree', tree, '-m', `openpulse checkpoint: ${input.name}`];
      if (head) commitArgs.push('-p', head);
      const commit = (await repo.git(commitArgs)).trim();
      await repo.git(['update-ref', `refs/openpulse/checkpoints/${id}`, commit]);

      const listed = await repo.git(['ls-tree', '-r', '--name-only', tree]);
      const files = listed.split('\n').filter(Boolean);
      return CheckpointSchema.parse({
        id,
        projectId: input.projectId,
        name: input.name,
        createdAt: Date.now(),
        kind: 'git',
        ref: commit,
        branch: (await repo.currentBranch()) ?? undefined,
        head: head || undefined,
        reason: input.reason ?? 'manual',
        fileCount: files.length,
        bytes: 0,
      });
    } catch (error) {
      throw new CheckpointError(
        'FAILED',
        `Could not snapshot the repository: ${(error as Error).message}`,
      );
    } finally {
      await fsp.rm(scratchIndex, { force: true }).catch(() => undefined);
    }
  }

  private async snapshotCopy(
    id: string,
    input: { projectId: string; projectDir: string; name: string; reason?: string },
  ): Promise<Checkpoint> {
    const target = path.join(this.dir, id, 'tree');
    await fsp.mkdir(target, { recursive: true });

    let fileCount = 0;
    let bytes = 0;
    const copy = async (dir: string, relative: string): Promise<void> => {
      const children = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const child of children) {
        const source = path.join(dir, child.name);
        const rel = relative ? `${relative}/${child.name}` : child.name;
        if (child.isDirectory()) {
          if (SKIP_DIRS.has(child.name)) continue;
          await copy(source, rel);
          continue;
        }
        if (!child.isFile()) continue;
        const stat = await fsp.stat(source).catch(() => undefined);
        if (!stat) continue;
        if (fileCount >= MAX_COPY_FILES || bytes + stat.size > MAX_COPY_BYTES) {
          throw new CheckpointError(
            'FAILED',
            'This project is too large to snapshot by copying. Put it under git, where checkpoints are cheap.',
          );
        }
        const destination = path.join(target, rel);
        await fsp.mkdir(path.dirname(destination), { recursive: true });
        await fsp.copyFile(source, destination);
        fileCount += 1;
        bytes += stat.size;
      }
    };
    await copy(input.projectDir, '');

    return CheckpointSchema.parse({
      id,
      projectId: input.projectId,
      name: input.name,
      createdAt: Date.now(),
      kind: 'copy',
      ref: id,
      reason: input.reason ?? 'manual',
      fileCount,
      bytes,
    });
  }

  /** Keep the newest N per project; older copy snapshots are deleted from disk. */
  private async prune(all: Checkpoint[], projectId: string): Promise<Checkpoint[]> {
    const max = this.options.maxPerProject ?? 20;
    const mine = all.filter((c) => c.projectId === projectId);
    if (mine.length <= max) return all;
    const doomed = mine.slice(max);
    for (const checkpoint of doomed) {
      if (checkpoint.kind === 'copy') {
        await fsp
          .rm(path.join(this.dir, checkpoint.ref), { recursive: true, force: true })
          .catch(() => undefined);
      }
    }
    const doomedIds = new Set(doomed.map((c) => c.id));
    return all.filter((c) => !doomedIds.has(c.id));
  }

  private async writeIndex(all: Checkpoint[]): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
    await writeFileAtomic(this.indexFile(), `${JSON.stringify(all, null, 2)}\n`);
  }
}

/** Relative path → size+mtime fingerprint, for copy-mode comparisons. */
async function listFiles(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string, relative: string): Promise<void> => {
    const children = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      const source = path.join(dir, child.name);
      const rel = relative ? `${relative}/${child.name}` : child.name;
      if (child.isDirectory()) {
        if (SKIP_DIRS.has(child.name)) continue;
        await walk(source, rel);
        continue;
      }
      if (!child.isFile()) continue;
      const stat = await fsp.stat(source).catch(() => undefined);
      if (stat) out.set(rel, `${stat.size}:${Math.round(stat.mtimeMs)}`);
    }
  };
  await walk(root, '');
  return out;
}
