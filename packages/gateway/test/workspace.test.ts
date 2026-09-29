import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileService, FileServiceError, hashOf } from '../src/workspace/file-service.js';
import { DEFAULT_DENY_PATTERNS, FsPolicy } from '../src/policy/fs-policy.js';
import { tempDir } from './helpers.js';

async function project(): Promise<{ dir: string; files: FileService }> {
  const dir = await tempDir('openpulse-ws-');
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.mkdir(path.join(dir, 'node_modules', 'left-pad'), { recursive: true });
  await fs.writeFile(path.join(dir, 'README.md'), '# Project\n');
  await fs.writeFile(path.join(dir, 'src', 'app.ts'), 'export const answer = 42;\n');
  await fs.writeFile(
    path.join(dir, 'node_modules', 'left-pad', 'index.js'),
    'module.exports = 1;\n',
  );
  const policy = new FsPolicy({
    mode: 'balanced',
    readRoots: [dir],
    writeRoots: [dir],
    denyPatterns: DEFAULT_DENY_PATTERNS,
  });
  return { dir, files: new FileService(dir, policy) };
}

describe('file service', () => {
  it('lists a project without the noise directories', async () => {
    const { files } = await project();
    const entries = await files.tree({ depth: 3 });
    const paths = entries.map((e) => e.path);

    expect(paths).toContain('README.md');
    expect(paths).toContain('src');
    expect(paths).toContain('src/app.ts');
    expect(paths.some((p) => p.startsWith('node_modules'))).toBe(false);
  });

  it('reads a file with a hash that reflects its bytes', async () => {
    const { dir, files } = await project();
    const file = await files.read('src/app.ts');

    expect(file.content).toBe('export const answer = 42;\n');
    expect(file.hash).toBe(hashOf(await fs.readFile(path.join(dir, 'src', 'app.ts'))));
  });

  it('refuses to read outside the project', async () => {
    const { files } = await project();
    await expect(files.read('../escape.txt')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(files.read('src/../../escape.txt')).rejects.toBeInstanceOf(FileServiceError);
  });

  it('writes when the base hash matches', async () => {
    const { files } = await project();
    const before = await files.read('src/app.ts');
    const after = await files.write('src/app.ts', 'export const answer = 43;\n', {
      baseHash: before.hash,
    });

    expect(after.content).toContain('43');
    expect(after.hash).not.toBe(before.hash);
  });

  it('refuses a write when the file changed underneath, and keeps the newer content', async () => {
    const { dir, files } = await project();
    const opened = await files.read('src/app.ts');

    // Someone else — the agent, another editor — writes first.
    await fs.writeFile(path.join(dir, 'src', 'app.ts'), 'export const answer = 99;\n');

    await expect(
      files.write('src/app.ts', 'export const answer = 7;\n', { baseHash: opened.hash }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(fs.readFile(path.join(dir, 'src', 'app.ts'), 'utf8')).resolves.toContain('99');
  });

  it('creates, renames and deletes', async () => {
    const { dir, files } = await project();
    await files.write('src/new.ts', 'export const x = 1;\n', { createOnly: true });
    await expect(files.write('src/new.ts', 'again', { createOnly: true })).rejects.toMatchObject({
      code: 'EXISTS',
    });

    await files.rename('src/new.ts', 'src/renamed.ts');
    await expect(fs.stat(path.join(dir, 'src', 'renamed.ts'))).resolves.toBeTruthy();

    await files.remove('src/renamed.ts');
    await expect(fs.stat(path.join(dir, 'src', 'renamed.ts'))).rejects.toThrow();
  });

  it('will not delete the project root', async () => {
    const { files } = await project();
    await expect(files.remove('.', { recursive: true })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('refuses to open a directory or a binary file', async () => {
    const { dir, files } = await project();
    await fs.writeFile(path.join(dir, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]));

    await expect(files.read('src')).rejects.toMatchObject({ code: 'INVALID' });
    await expect(files.read('blob.bin')).rejects.toMatchObject({ code: 'BINARY' });
  });

  it('searches file contents and reports line numbers', async () => {
    const { files } = await project();
    const hits = await files.search('answer');

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ path: 'src/app.ts', line: 1 });
    expect(hits[0]!.text).toContain('answer');
  });

  it('will not write where the policy forbids it', async () => {
    const dir = await tempDir();
    const policy = new FsPolicy({
      mode: 'read-only',
      readRoots: [dir],
      writeRoots: [dir],
      denyPatterns: DEFAULT_DENY_PATTERNS,
    });
    const files = new FileService(dir, policy);

    await expect(files.write('note.txt', 'hello')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
