import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { GitRepo, gitAvailable, gitClone, GitError } from '../src/git/git.js';
import { tempDir } from './helpers.js';

let git = { available: false } as { available: boolean; version?: string };

beforeAll(async () => {
  git = await gitAvailable();
});

/** A throwaway repository with one commit, so the tests exercise real git behaviour. */
async function repo(): Promise<GitRepo> {
  const dir = await tempDir('openpulse-git-');
  const r = new GitRepo(dir);
  await r.git(['init', '--initial-branch=main']);
  await r.git(['config', 'user.email', 'test@openpulse.local']);
  await r.git(['config', 'user.name', 'OpenPulse Test']);
  await r.git(['config', 'commit.gpgsign', 'false']);
  await fs.writeFile(path.join(dir, 'README.md'), '# Test project\n');
  await r.add(['README.md']);
  await r.commit('Initial commit');
  return r;
}

describe.runIf(process.env.CI !== 'skip-git')('git service', () => {
  it('reports whether git is installed', () => {
    expect(typeof git.available).toBe('boolean');
    if (git.available) expect(git.version).toMatch(/git version/i);
  });

  it('recognises a repository and its root', async () => {
    if (!git.available) return;
    const r = await repo();
    await expect(r.isRepo()).resolves.toBe(true);
    await expect(r.root()).resolves.toBe(path.resolve(r.dir));

    const notRepo = new GitRepo(await tempDir());
    await expect(notRepo.isRepo()).resolves.toBe(false);
  });

  it('reports a clean tree, then every kind of change', async () => {
    if (!git.available) return;
    const r = await repo();
    const clean = await r.status();
    expect(clean.clean).toBe(true);
    expect(clean.branch).toBe('main');
    expect(clean.files).toEqual([]);

    await fs.writeFile(path.join(r.dir, 'README.md'), '# Test project\n\nMore.\n');
    await fs.writeFile(path.join(r.dir, 'new.txt'), 'fresh\n');
    await fs.mkdir(path.join(r.dir, 'src'), { recursive: true });
    await fs.writeFile(path.join(r.dir, 'src', 'app.ts'), 'export const a = 1;\n');
    await r.add(['src/app.ts']);

    const dirty = await r.status();
    expect(dirty.clean).toBe(false);
    const byPath = new Map(dirty.files.map((f) => [f.path, f]));
    expect(byPath.get('README.md')?.worktree).toBe('M');
    expect(byPath.get('README.md')?.staged).toBe(false);
    expect(byPath.get('new.txt')?.untracked).toBe(true);
    expect(byPath.get('src/app.ts')?.staged).toBe(true);
  });

  it('produces a real diff of the working tree', async () => {
    if (!git.available) return;
    const r = await repo();
    await fs.writeFile(path.join(r.dir, 'README.md'), '# Test project\n\nA new line.\n');

    const diff = await r.diff();
    expect(diff).toContain('--- a/README.md');
    expect(diff).toContain('+++ b/README.md');
    expect(diff).toContain('+A new line.');

    await r.add(['README.md']);
    expect(await r.diff()).toBe('');
    expect(await r.diff({ staged: true })).toContain('+A new line.');
  });

  it('lists commits with their subjects', async () => {
    if (!git.available) return;
    const r = await repo();
    await fs.writeFile(path.join(r.dir, 'second.txt'), 'two\n');
    await r.add(['second.txt']);
    await r.commit('Add the second file\n\nWith a body.');

    const log = await r.log(10);
    expect(log).toHaveLength(2);
    expect(log[0]!.subject).toBe('Add the second file');
    expect(log[0]!.body).toBe('With a body.');
    expect(log[0]!.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(log[1]!.subject).toBe('Initial commit');
  });

  it('creates and switches branches', async () => {
    if (!git.available) return;
    const r = await repo();
    await r.checkout('feature/login', { create: true });
    await expect(r.currentBranch()).resolves.toBe('feature/login');

    const branches = await r.branches(false);
    expect(branches.map((b) => b.name)).toEqual(expect.arrayContaining(['main', 'feature/login']));
    expect(branches.find((b) => b.name === 'feature/login')?.current).toBe(true);

    await r.checkout('main');
    await expect(r.currentBranch()).resolves.toBe('main');
  });

  it('treats branch names as arguments, not shell input', async () => {
    if (!git.available) return;
    const r = await repo();
    const marker = path.join(r.dir, 'pwned.txt');

    await expect(
      r.checkout('main; echo pwned > pwned.txt', { create: true }),
    ).rejects.toBeInstanceOf(GitError);
    await expect(fs.stat(marker)).rejects.toThrow();
  });

  it('shows a file at a revision', async () => {
    if (!git.available) return;
    const r = await repo();
    await fs.writeFile(path.join(r.dir, 'README.md'), '# Changed\n');
    await expect(r.show('HEAD', 'README.md')).resolves.toBe('# Test project\n');
  });

  it('clones a local repository', async () => {
    if (!git.available) return;
    const source = await repo();
    const target = path.join(await tempDir(), 'clone');

    await gitClone(source.dir, target, { timeoutMs: 60_000 });
    const cloned = new GitRepo(target);
    await expect(cloned.isRepo()).resolves.toBe(true);
    await expect(fs.readFile(path.join(target, 'README.md'), 'utf8')).resolves.toContain(
      '# Test project',
    );
  });

  it('turns a git failure into a GitError with the reason', async () => {
    if (!git.available) return;
    const r = await repo();
    await expect(r.checkout('does-not-exist')).rejects.toMatchObject({
      name: 'GitError',
      message: expect.stringContaining('did not match'),
    });
  });
});
