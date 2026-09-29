import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChangeError, ChangeStore } from '../src/changes/proposals.js';
import { diffStat, unifiedDiff } from '../src/changes/diff.js';
import { DEFAULT_DENY_PATTERNS, FsPolicy } from '../src/policy/fs-policy.js';
import { FileService } from '../src/workspace/file-service.js';
import { tempDir } from './helpers.js';

async function setup() {
  const projectDir = await tempDir('openpulse-changes-');
  await fs.mkdir(path.join(projectDir, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, 'src', 'auth.ts'),
    'export function login() {\n  return true;\n}\n',
  );
  const policy = new FsPolicy({
    mode: 'balanced',
    readRoots: [projectDir],
    writeRoots: [projectDir],
    denyPatterns: DEFAULT_DENY_PATTERNS,
  });
  const files = new FileService(projectDir, policy);
  const store = new ChangeStore(path.join(await tempDir(), 'changes'));
  return { projectDir, files, store };
}

describe('unified diff', () => {
  it('describes an edit the way a reviewer expects', () => {
    const diff = unifiedDiff('a\nb\nc\n', 'a\nB\nc\n', { path: 'src/x.ts' });

    expect(diff).toContain('--- a/src/x.ts');
    expect(diff).toContain('+++ b/src/x.ts');
    expect(diff).toContain('-b');
    expect(diff).toContain('+B');
    expect(diff).toContain(' a');
  });

  it('handles creation and deletion', () => {
    expect(unifiedDiff('', 'hello\n', { path: 'new.txt' })).toContain('+hello');
    expect(unifiedDiff('bye\n', '', { path: 'gone.txt' })).toContain('-bye');
    expect(unifiedDiff('same\n', 'same\n')).toBe('');
  });

  it('counts additions and deletions', () => {
    expect(diffStat('a\nb\n', 'a\nb\nc\n')).toEqual({ additions: 1, deletions: 0 });
    expect(diffStat('a\nb\nc\n', 'a\n')).toEqual({ additions: 0, deletions: 2 });
    expect(diffStat('a\n', 'z\n')).toEqual({ additions: 1, deletions: 1 });
  });

  it('keeps context around separate edits', () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 2', 'line two').replace('line 25', 'line twenty-five');
    const diff = unifiedDiff(before, after, { path: 'big.txt' });

    // Two separate edits, so two hunks rather than one spanning the whole file.
    expect(diff.match(/^@@/gm)).toHaveLength(2);
    expect(diff).toContain('+line two');
    expect(diff).toContain('+line twenty-five');
  });
});

describe('change proposals', () => {
  it('records a proposal without touching the working tree', async () => {
    const { projectDir, files, store } = await setup();

    const set = await store.create({
      projectId: 'p1',
      title: 'Handle failed logins',
      files: [
        {
          path: 'src/auth.ts',
          action: 'modify',
          content: 'export function login() {\n  return false;\n}\n',
        },
      ],
      files_service: files,
    });

    expect(set.status).toBe('pending');
    expect(set.files[0]).toMatchObject({ status: 'pending', additions: 1, deletions: 1 });
    await expect(fs.readFile(path.join(projectDir, 'src', 'auth.ts'), 'utf8')).resolves.toContain(
      'return true',
    );
  });

  it('shows a diff against what is on disk', async () => {
    const { files, store } = await setup();
    const set = await store.create({
      projectId: 'p1',
      title: 'Add logging',
      files: [
        {
          path: 'src/auth.ts',
          action: 'modify',
          content: 'export function login() {\n  console.log("in");\n  return true;\n}\n',
        },
      ],
      files_service: files,
    });

    const view = await store.view(set.id, files);
    expect(view.files[0]!.diff).toContain('+  console.log("in");');
    expect(view.files[0]!.stale).toBe(false);
    expect(view.stats).toMatchObject({ files: 1, additions: 1, deletions: 0 });
  });

  it('applies only the approved files', async () => {
    const { projectDir, files, store } = await setup();
    const set = await store.create({
      projectId: 'p1',
      title: 'Two files',
      files: [
        {
          path: 'src/auth.ts',
          action: 'modify',
          content: 'export function login() {\n  return false;\n}\n',
        },
        { path: 'src/new.ts', action: 'create', content: 'export const added = true;\n' },
      ],
      files_service: files,
    });

    await store.decide(set.id, 'approved', ['src/new.ts']);
    await store.decide(set.id, 'rejected', ['src/auth.ts']);
    const result = await store.apply(set.id, files);

    expect(result.applied).toEqual(['src/new.ts']);
    expect(result.skipped[0]).toMatchObject({ path: 'src/auth.ts', reason: 'rejected' });
    await expect(fs.readFile(path.join(projectDir, 'src', 'new.ts'), 'utf8')).resolves.toContain(
      'added = true',
    );
    await expect(fs.readFile(path.join(projectDir, 'src', 'auth.ts'), 'utf8')).resolves.toContain(
      'return true',
    );
  });

  it('refuses to apply a patch whose file changed afterwards', async () => {
    const { projectDir, files, store } = await setup();
    const set = await store.create({
      projectId: 'p1',
      title: 'Stale change',
      files: [
        {
          path: 'src/auth.ts',
          action: 'modify',
          content: 'export function login() {\n  return false;\n}\n',
        },
      ],
      files_service: files,
    });
    await store.decide(set.id, 'approved');

    // The developer edits the same file before approving.
    await fs.writeFile(
      path.join(projectDir, 'src', 'auth.ts'),
      'export function login() {\n  return "maybe";\n}\n',
    );

    const result = await store.apply(set.id, files);
    expect(result.applied).toEqual([]);
    expect(result.skipped[0]!.reason).toContain('changed after this was proposed');
    await expect(fs.readFile(path.join(projectDir, 'src', 'auth.ts'), 'utf8')).resolves.toContain(
      '"maybe"',
    );
  });

  it('marks a proposal stale as soon as the file moves under it', async () => {
    const { projectDir, files, store } = await setup();
    const set = await store.create({
      projectId: 'p1',
      title: 'Will go stale',
      files: [
        {
          path: 'src/auth.ts',
          action: 'modify',
          content: 'export function login() {\n  return false;\n}\n',
        },
      ],
      files_service: files,
    });

    await fs.writeFile(path.join(projectDir, 'src', 'auth.ts'), 'changed\n');
    const view = await store.view(set.id, files);
    expect(view.files[0]!.stale).toBe(true);
  });

  it('applies a deletion, and reports a partial application', async () => {
    const { projectDir, files, store } = await setup();
    await fs.writeFile(path.join(projectDir, 'src', 'old.ts'), 'export const old = 1;\n');

    const set = await store.create({
      projectId: 'p1',
      title: 'Remove the old module',
      files: [
        { path: 'src/old.ts', action: 'delete' },
        {
          path: 'src/auth.ts',
          action: 'modify',
          content: 'export function login() {\n  return false;\n}\n',
        },
      ],
      files_service: files,
    });

    await store.decide(set.id, 'approved', ['src/old.ts']);
    const result = await store.apply(set.id, files);

    expect(result.applied).toEqual(['src/old.ts']);
    expect(result.status).toBe('partial');
    await expect(fs.stat(path.join(projectDir, 'src', 'old.ts'))).rejects.toThrow();
  });

  it('refuses nonsense proposals', async () => {
    const { files, store } = await setup();

    await expect(
      store.create({ projectId: 'p1', title: 'Empty', files: [], files_service: files }),
    ).rejects.toBeInstanceOf(ChangeError);

    await expect(
      store.create({
        projectId: 'p1',
        title: 'Modify a file that is not there',
        files: [{ path: 'src/missing.ts', action: 'modify', content: 'x' }],
        files_service: files,
      }),
    ).rejects.toThrow(/does not exist/);

    await expect(
      store.create({
        projectId: 'p1',
        title: 'Create over an existing file',
        files: [{ path: 'src/auth.ts', action: 'create', content: 'x' }],
        files_service: files,
      }),
    ).rejects.toThrow(/already exists/);
  });

  it('keeps proposals across a reload and lists them per project', async () => {
    const { files, store } = await setup();
    const set = await store.create({
      projectId: 'p1',
      title: 'Persisted',
      files: [
        {
          path: 'src/auth.ts',
          action: 'modify',
          content: 'export function login() {\n  return false;\n}\n',
        },
      ],
      files_service: files,
    });

    const reopened = new ChangeStore(store.dir);
    await expect(reopened.get(set.id)).resolves.toMatchObject({ title: 'Persisted' });
    await expect(reopened.list('p1')).resolves.toHaveLength(1);
    await expect(reopened.list('other')).resolves.toHaveLength(0);
    expect(await reopened.remove(set.id)).toBe(true);
    await expect(reopened.list('p1')).resolves.toHaveLength(0);
  });
});
