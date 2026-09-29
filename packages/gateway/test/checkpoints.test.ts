import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { CheckpointService } from '../src/checkpoints/service.js';
import { GitRepo, gitAvailable } from '../src/git/git.js';
import { tempDir } from './helpers.js';

let git = { available: false } as { available: boolean };

beforeAll(async () => {
  git = await gitAvailable();
});

async function gitProject(): Promise<string> {
  const dir = await tempDir('openpulse-cp-');
  const repo = new GitRepo(dir);
  await repo.git(['init', '--initial-branch=main']);
  await repo.git(['config', 'user.email', 'test@openpulse.local']);
  await repo.git(['config', 'user.name', 'OpenPulse Test']);
  await repo.git(['config', 'commit.gpgsign', 'false']);
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'app.ts'), 'export const version = 1;\n');
  await repo.add(['.']);
  await repo.commit('Initial commit');
  return dir;
}

async function plainProject(): Promise<string> {
  const dir = await tempDir('openpulse-cp-plain-');
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'app.ts'), 'export const version = 1;\n');
  return dir;
}

async function service(): Promise<CheckpointService> {
  return new CheckpointService(path.join(await tempDir(), 'checkpoints'));
}

describe('checkpoints in a git project', () => {
  it('captures uncommitted and untracked work without disturbing the index', async () => {
    if (!git.available) return;
    const dir = await gitProject();
    const repo = new GitRepo(dir);
    const checkpoints = await service();

    // Uncommitted edit, a staged file, and an untracked file.
    await fs.writeFile(path.join(dir, 'src', 'app.ts'), 'export const version = 2;\n');
    await fs.writeFile(path.join(dir, 'staged.txt'), 'staged\n');
    await repo.add(['staged.txt']);
    await fs.writeFile(path.join(dir, 'untracked.txt'), 'untracked\n');

    const before = await repo.status();
    const checkpoint = await checkpoints.create({
      projectId: 'p1',
      projectDir: dir,
      name: 'Before refactor',
    });

    expect(checkpoint.kind).toBe('git');
    expect(checkpoint.branch).toBe('main');
    expect(checkpoint.fileCount).toBeGreaterThanOrEqual(3);

    // The developer's own index is untouched.
    const after = await repo.status();
    expect(after.files.find((f) => f.path === 'staged.txt')?.staged).toBe(true);
    expect(after.files.map((f) => f.path).sort()).toEqual(before.files.map((f) => f.path).sort());
  });

  it('previews exactly what a restore would change', async () => {
    if (!git.available) return;
    const dir = await gitProject();
    const checkpoints = await service();
    const checkpoint = await checkpoints.create({
      projectId: 'p1',
      projectDir: dir,
      name: 'Known good',
    });

    await fs.writeFile(path.join(dir, 'src', 'app.ts'), 'export const version = 99;\n');
    await fs.writeFile(path.join(dir, 'brand-new.ts'), 'export const extra = true;\n');

    const preview = await checkpoints.preview(checkpoint.id, dir);
    const byPath = new Map(preview.entries.map((e) => [e.path, e]));

    expect(byPath.get('src/app.ts')?.action).toBe('restore');
    expect(byPath.get('brand-new.ts')?.action).toBe('delete');
    expect(preview.changes).toBe(1);
    expect(preview.removals).toBe(1);
  });

  it('restores the snapshot and keeps the replaced state recoverable', async () => {
    if (!git.available) return;
    const dir = await gitProject();
    const checkpoints = await service();
    await fs.writeFile(path.join(dir, 'src', 'app.ts'), 'export const version = 2;\n');
    const checkpoint = await checkpoints.create({
      projectId: 'p1',
      projectDir: dir,
      name: 'Version two',
    });

    await fs.writeFile(path.join(dir, 'src', 'app.ts'), 'export const version = 3;\n');
    await fs.writeFile(path.join(dir, 'scratch.txt'), 'temporary\n');

    const { restored, safety } = await checkpoints.restore({
      id: checkpoint.id,
      projectId: 'p1',
      projectDir: dir,
    });

    await expect(fs.readFile(path.join(dir, 'src', 'app.ts'), 'utf8')).resolves.toBe(
      'export const version = 2;\n',
    );
    await expect(fs.stat(path.join(dir, 'scratch.txt'))).rejects.toThrow();
    expect(restored.entries.length).toBeGreaterThan(0);

    // The state that was replaced is itself a checkpoint, so the rollback can be rolled back.
    expect(safety.name).toContain('Before restoring');
    await checkpoints.restore({ id: safety.id, projectId: 'p1', projectDir: dir });
    await expect(fs.readFile(path.join(dir, 'src', 'app.ts'), 'utf8')).resolves.toBe(
      'export const version = 3;\n',
    );
    await expect(fs.readFile(path.join(dir, 'scratch.txt'), 'utf8')).resolves.toBe('temporary\n');
  });

  it('keeps checkpoints listed per project and removable', async () => {
    if (!git.available) return;
    const dir = await gitProject();
    const checkpoints = await service();
    const first = await checkpoints.create({ projectId: 'p1', projectDir: dir, name: 'One' });
    await checkpoints.create({ projectId: 'p2', projectDir: dir, name: 'Two' });

    await expect(checkpoints.list('p1')).resolves.toHaveLength(1);
    await expect(checkpoints.list()).resolves.toHaveLength(2);
    expect(await checkpoints.remove(first.id)).toBe(true);
    await expect(checkpoints.list('p1')).resolves.toHaveLength(0);
  });
});

describe('checkpoints without git', () => {
  it('snapshots by copying, then restores', async () => {
    const dir = await plainProject();
    const checkpoints = await service();

    const checkpoint = await checkpoints.create({
      projectId: 'p1',
      projectDir: dir,
      name: 'Copy snapshot',
    });
    expect(checkpoint.kind).toBe('copy');
    expect(checkpoint.fileCount).toBe(1);

    await fs.writeFile(path.join(dir, 'src', 'app.ts'), 'export const version = 42;\n');
    await fs.writeFile(path.join(dir, 'extra.ts'), 'export const extra = 1;\n');

    const preview = await checkpoints.preview(checkpoint.id, dir);
    expect(preview.entries.find((e) => e.path === 'extra.ts')?.action).toBe('delete');

    await checkpoints.restore({ id: checkpoint.id, projectId: 'p1', projectDir: dir });
    await expect(fs.readFile(path.join(dir, 'src', 'app.ts'), 'utf8')).resolves.toBe(
      'export const version = 1;\n',
    );
    await expect(fs.stat(path.join(dir, 'extra.ts'))).rejects.toThrow();
  });
});

describe('checkpoint retention', () => {
  it('keeps only the configured number per project', async () => {
    const dir = await plainProject();
    const checkpoints = new CheckpointService(path.join(await tempDir(), 'checkpoints'), {
      maxPerProject: 3,
    });

    for (let i = 0; i < 5; i += 1) {
      await checkpoints.create({ projectId: 'p1', projectDir: dir, name: `Snapshot ${i}` });
    }

    const kept = await checkpoints.list('p1');
    expect(kept).toHaveLength(3);
    expect(kept[0]!.name).toBe('Snapshot 4');
  });
});
