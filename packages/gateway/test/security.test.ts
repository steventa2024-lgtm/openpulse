import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTools } from '../src/agent/tools/index.js';
import { readTool, writeTool, editTool } from '../src/agent/tools/fs-tools.js';
import type { ToolContext } from '../src/agent/tools/types.js';
import { ConfigSchema } from '../src/config/schema.js';
import { DEFAULT_DENY_PATTERNS, FsPolicy, globMatch } from '../src/policy/fs-policy.js';
import { ProjectStore, ProjectError } from '../src/workspace/projects.js';
import { silentLogger } from '../src/infra/logger.js';
import { tempDir } from './helpers.js';

const config = ConfigSchema.parse({});

function policy(
  roots: { read: string[]; write?: string[] },
  mode: 'read-only' | 'balanced' | 'custom' = 'balanced',
) {
  return new FsPolicy({
    mode,
    readRoots: roots.read,
    writeRoots: roots.write ?? roots.read,
    denyPatterns: DEFAULT_DENY_PATTERNS,
  });
}

function context(workspace: string, fsPolicy: FsPolicy): ToolContext {
  return {
    agentId: 'main',
    sessionKey: 'agent:main:main',
    runId: 'run-1',
    workspace,
    fsPolicy,
    config,
    log: silentLogger,
    extraEnv: {},
    isMainSession: true,
    services: {} as ToolContext['services'],
  };
}

describe('filesystem policy', () => {
  it('allows paths inside a root and refuses everything else', () => {
    const p = policy({ read: ['/work/project'] });
    expect(p.canRead('/work/project/src/index.ts').allowed).toBe(true);
    expect(p.canRead('/work/project').allowed).toBe(true);

    const outside = p.canRead('/work/other/secrets.txt');
    expect(outside.allowed).toBe(false);
    expect(outside.reason).toContain('outside the allowed workspace');
  });

  it('refuses traversal out of a root', () => {
    const p = policy({ read: ['/work/project'] });
    expect(p.canRead('/work/project/../other/file.txt').allowed).toBe(false);
    expect(p.canRead('/work/project/src/../../escape.txt').allowed).toBe(false);
    // A sibling whose name merely starts the same way is not inside the root.
    expect(p.canRead('/work/project-other/file.txt').allowed).toBe(false);
  });

  it('refuses secrets even inside an allowed root', () => {
    const p = policy({ read: ['/work'] });
    expect(p.canRead('/work/.ssh/id_rsa').allowed).toBe(false);
    expect(p.canRead('/work/deploy/server.pem').allowed).toBe(false);
    expect(p.canRead('/work/.git-credentials').allowed).toBe(false);
    expect(p.canRead('/work/src/app.ts').allowed).toBe(true);
  });

  it('has no write roots at all in read-only mode', () => {
    const p = policy({ read: ['/work'] }, 'read-only');
    expect(p.canRead('/work/src/app.ts').allowed).toBe(true);
    const write = p.canWrite('/work/src/app.ts');
    expect(write.allowed).toBe(false);
    expect(write.reason).toContain('read-only');
  });

  it('can allow reading a root without allowing writes to it', () => {
    const p = policy({ read: ['/work/lib', '/work/app'], write: ['/work/app'] });
    expect(p.canRead('/work/lib/a.ts').allowed).toBe(true);
    expect(p.canWrite('/work/lib/a.ts').allowed).toBe(false);
    expect(p.canWrite('/work/app/a.ts').allowed).toBe(true);
  });

  it('matches glob patterns the way the deny list needs', () => {
    expect(globMatch('**/.ssh/**', '/home/dev/.ssh/config')).toBe(true);
    expect(globMatch('**/*.pem', 'C:/keys/site.pem')).toBe(true);
    expect(globMatch('**/.ssh/**', '/home/dev/sshconfig')).toBe(false);
    expect(globMatch('/state/credentials/**', '/state/credentials/telegram.json')).toBe(true);
  });
});

describe('filesystem tools honour the policy', () => {
  it('refuses to read outside the roots, and says why', async () => {
    const dir = await tempDir();
    const outside = path.join(await tempDir(), 'secret.txt');
    await fs.writeFile(outside, 'classified');
    const ctx = context(dir, policy({ read: [dir] }));

    const result = await readTool.execute({ path: outside }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('outside the allowed workspace');
  });

  it('refuses to write outside the roots and leaves the file alone', async () => {
    const dir = await tempDir();
    const otherDir = await tempDir();
    const target = path.join(otherDir, 'untouched.txt');
    await fs.writeFile(target, 'original');
    const ctx = context(dir, policy({ read: [dir] }));

    const result = await writeTool.execute({ path: target, content: 'overwritten' }, ctx);
    expect(result.isError).toBe(true);
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('original');
  });

  it('refuses an edit that escapes the workspace with ..', async () => {
    const dir = await tempDir();
    const otherDir = await tempDir();
    const target = path.join(otherDir, 'app.ts');
    await fs.writeFile(target, 'const a = 1;');
    const ctx = context(dir, policy({ read: [dir] }));

    const relative = path.relative(dir, target);
    const result = await editTool.execute(
      { path: relative, oldText: 'const a = 1;', newText: 'const a = 2;' },
      ctx,
    );
    expect(result.isError).toBe(true);
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('const a = 1;');
  });

  it('allows work inside the roots', async () => {
    const dir = await tempDir();
    const ctx = context(dir, policy({ read: [dir] }));

    const written = await writeTool.execute(
      { path: 'src/app.ts', content: 'export const a = 1;' },
      ctx,
    );
    expect(written.isError).toBeFalsy();

    const read = await readTool.execute({ path: 'src/app.ts' }, ctx);
    expect(read.content).toContain('export const a = 1;');

    const edited = await editTool.execute(
      { path: 'src/app.ts', oldText: 'const a = 1', newText: 'const a = 2' },
      ctx,
    );
    expect(edited.isError).toBeFalsy();
    await expect(fs.readFile(path.join(dir, 'src', 'app.ts'), 'utf8')).resolves.toContain('a = 2');
  });

  it('refuses to read a private key inside the workspace', async () => {
    const dir = await tempDir();
    await fs.mkdir(path.join(dir, '.ssh'), { recursive: true });
    await fs.writeFile(path.join(dir, '.ssh', 'id_rsa'), 'PRIVATE KEY');
    const ctx = context(dir, policy({ read: [dir] }));

    const result = await readTool.execute({ path: '.ssh/id_rsa' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('always-denied');
  });
});

describe('security modes select tools', () => {
  it('read-only mode offers no tool that can change the machine', () => {
    const readOnly = ConfigSchema.parse({ security: { mode: 'read-only' } });
    const names = buildTools({ config: readOnly, browser: {} as never }).map((t) => t.name);

    expect(names).toContain('read');
    expect(names).not.toContain('write');
    expect(names).not.toContain('edit');
    expect(names).not.toContain('exec');
    expect(names).not.toContain('process');
  });

  it('custom mode switches off exactly the named tools', () => {
    const custom = ConfigSchema.parse({
      security: { mode: 'custom', tools: { exec: false, browser: false, write: true } },
    });
    const names = buildTools({ config: custom, browser: {} as never }).map((t) => t.name);

    expect(names).toContain('write');
    expect(names).toContain('read');
    expect(names).not.toContain('exec');
    expect(names).not.toContain('browser');
  });

  it('balanced mode keeps the full tool set', () => {
    const names = buildTools({ config, browser: {} as never }).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['read', 'write', 'edit', 'exec', 'process']));
  });
});

describe('project registry', () => {
  it('registers a directory and reports it as a root', async () => {
    const dir = await tempDir();
    const projectDir = path.join(dir, 'my-app');
    await fs.mkdir(projectDir, { recursive: true });
    const store = new ProjectStore(path.join(dir, 'projects.json'));

    const project = await store.add({ path: projectDir });
    expect(project.name).toBe('my-app');
    expect(project.vcs).toBe('none');
    await expect(store.roots()).resolves.toContain(projectDir);
    await expect(store.active()).resolves.toMatchObject({ id: project.id });
  });

  it('refuses a path that is not a directory, and the home folder', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'file.txt');
    await fs.writeFile(file, 'hi');
    const store = new ProjectStore(path.join(dir, 'projects.json'));

    await expect(store.add({ path: file })).rejects.toBeInstanceOf(ProjectError);
    await expect(store.add({ path: path.join(dir, 'missing') })).rejects.toThrow(
      /No such directory/,
    );
    await expect(store.add({ path: os.homedir() })).rejects.toThrow(/too broad/);
  });

  it('refuses the same folder twice and survives a reload', async () => {
    const dir = await tempDir();
    const projectDir = path.join(dir, 'app');
    await fs.mkdir(projectDir);
    const file = path.join(dir, 'projects.json');
    const store = new ProjectStore(file);
    const project = await store.add({ path: projectDir });

    await expect(store.add({ path: projectDir })).rejects.toThrow(/already a project/);

    const reopened = new ProjectStore(file);
    await reopened.load();
    await expect(reopened.list()).resolves.toHaveLength(1);
    await expect(reopened.active()).resolves.toMatchObject({ id: project.id });

    expect(await reopened.remove(project.id)).toBe(true);
    await expect(reopened.list()).resolves.toHaveLength(0);
    await expect(reopened.active()).resolves.toBeUndefined();
  });

  it('detects a git working copy and its origin remote', async () => {
    const dir = await tempDir();
    const projectDir = path.join(dir, 'repo');
    await fs.mkdir(path.join(projectDir, '.git'), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, '.git', 'config'),
      '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://github.com/example/repo.git\n\tfetch = +refs/heads/*\n',
    );
    const store = new ProjectStore(path.join(dir, 'projects.json'));

    const project = await store.add({ path: projectDir });
    expect(project.vcs).toBe('git');
    expect(project.remote).toBe('https://github.com/example/repo.git');
  });
});
