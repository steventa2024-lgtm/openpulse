import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GatewayClient } from '../src/client/gateway-client.js';
import { startGateway, type RunningGateway } from '../src/start.js';
import { gitAvailable, GitRepo } from '../src/git/git.js';
import { tempDir } from './helpers.js';

const gateways: RunningGateway[] = [];
const clients: GatewayClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const gateway of gateways.splice(0)) await gateway.stop();
});

/** A gateway plus a connected operator client, on a throwaway state dir. */
async function harness() {
  const stateDir = path.join(await tempDir(), '.openpulse');
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    path.join(stateDir, 'openpulse.json'),
    JSON.stringify({
      gateway: { auth: { mode: 'token', token: 'test-token' } },
      agents: { defaults: { heartbeat: { every: '0m' } } },
    }),
  );
  const gateway = await startGateway({
    stateDir,
    env: {},
    port: 0,
    controlUiDir: false,
    channels: false,
    cron: false,
    heartbeat: false,
  });
  gateways.push(gateway);

  const client = new GatewayClient({
    url: gateway.url,
    token: 'test-token',
    clientId: 'test',
    mode: 'cli',
  });
  clients.push(client);
  await client.connect();
  return { gateway, client, stateDir };
}

/** A directory that looks like a project. */
async function sampleProject(): Promise<string> {
  const dir = path.join(await tempDir(), 'sample-app');
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(path.join(dir, 'README.md'), '# Sample\n');
  await fs.writeFile(path.join(dir, 'src', 'index.ts'), 'export const start = () => 1;\n');
  return dir;
}

describe('project RPCs', () => {
  it('registers a project, makes it active and widens the filesystem policy', async () => {
    const { client } = await harness();
    const dir = await sampleProject();

    const before = await client.request<{ roots: { readRoots: string[] } }>('projects.list');
    expect(before.roots.readRoots.some((root) => root.includes('sample-app'))).toBe(false);

    const added = await client.request<{ project: { id: string; name: string } }>('projects.add', {
      path: dir,
    });
    expect(added.project.name).toBe('sample-app');

    const after = await client.request<{
      projects: { id: string }[];
      active: { id: string } | null;
      roots: { readRoots: string[]; writeRoots: string[] };
    }>('projects.list');
    expect(after.projects).toHaveLength(1);
    expect(after.active?.id).toBe(added.project.id);
    expect(after.roots.readRoots.some((root) => root.includes('sample-app'))).toBe(true);
    expect(after.roots.writeRoots.some((root) => root.includes('sample-app'))).toBe(true);
  });

  it('refuses a directory that does not exist', async () => {
    const { client } = await harness();
    await expect(
      client.request('projects.add', { path: path.join(await tempDir(), 'nope') }),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });

  it('removes a project and narrows the policy again', async () => {
    const { client } = await harness();
    const dir = await sampleProject();
    const added = await client.request<{ project: { id: string } }>('projects.add', { path: dir });

    await expect(
      client.request('projects.remove', { id: added.project.id }),
    ).resolves.toMatchObject({ removed: true });
    const after = await client.request<{ roots: { readRoots: string[] } }>('projects.list');
    expect(after.roots.readRoots.some((root) => root.includes('sample-app'))).toBe(false);
  });
});

describe('workspace file RPCs', () => {
  it('lists, reads and writes project files', async () => {
    const { client } = await harness();
    const dir = await sampleProject();
    await client.request('projects.add', { path: dir });

    const tree = await client.request<{ entries: { path: string }[] }>('workspace.tree', {
      depth: 2,
    });
    expect(tree.entries.map((e) => e.path)).toEqual(
      expect.arrayContaining(['README.md', 'src', 'src/index.ts']),
    );

    const file = await client.request<{ content: string; hash: string }>('workspace.file.read', {
      path: 'src/index.ts',
    });
    expect(file.content).toContain('export const start');

    const written = await client.request<{ hash: string }>('workspace.file.write', {
      path: 'src/index.ts',
      content: 'export const start = () => 2;\n',
      baseHash: file.hash,
    });
    expect(written.hash).not.toBe(file.hash);
    await expect(fs.readFile(path.join(dir, 'src', 'index.ts'), 'utf8')).resolves.toContain('=> 2');
  });

  it('refuses a stale write instead of overwriting newer content', async () => {
    const { client } = await harness();
    const dir = await sampleProject();
    await client.request('projects.add', { path: dir });
    const file = await client.request<{ hash: string }>('workspace.file.read', {
      path: 'README.md',
    });

    await fs.writeFile(path.join(dir, 'README.md'), '# Changed elsewhere\n');

    await expect(
      client.request('workspace.file.write', {
        path: 'README.md',
        content: '# Stale\n',
        baseHash: file.hash,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(fs.readFile(path.join(dir, 'README.md'), 'utf8')).resolves.toBe(
      '# Changed elsewhere\n',
    );
  });

  it('refuses to read outside the project', async () => {
    const { client } = await harness();
    await client.request('projects.add', { path: await sampleProject() });

    await expect(
      client.request('workspace.file.read', { path: '../outside.txt' }),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });

  it('explains itself when no project is selected', async () => {
    const { client } = await harness();
    await expect(client.request('workspace.tree')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining('No project is selected'),
    });
  });

  it('searches across the project', async () => {
    const { client } = await harness();
    await client.request('projects.add', { path: await sampleProject() });

    const found = await client.request<{ hits: { path: string; line: number }[] }>(
      'workspace.search',
      {
        query: 'export const start',
      },
    );
    expect(found.hits[0]).toMatchObject({ path: 'src/index.ts', line: 1 });
  });
});

describe('git RPCs', () => {
  it('reports when a project is not a git repository', async () => {
    const { client } = await harness();
    await client.request('projects.add', { path: await sampleProject() });

    await expect(client.request('git.status')).resolves.toMatchObject({ isRepo: false });
  });

  it('reports status, branches, log and diff for a real repository', async () => {
    const git = await gitAvailable();
    if (!git.available) return;

    const { client } = await harness();
    const dir = await sampleProject();
    const repo = new GitRepo(dir);
    await repo.git(['init', '--initial-branch=main']);
    await repo.git(['config', 'user.email', 'test@openpulse.local']);
    await repo.git(['config', 'user.name', 'OpenPulse Test']);
    await repo.add(['.']);
    await repo.commit('Initial commit');
    await client.request('projects.add', { path: dir });

    const status = await client.request<{
      isRepo: boolean;
      status: { branch: string; clean: boolean };
    }>('git.status');
    expect(status.isRepo).toBe(true);
    expect(status.status.branch).toBe('main');
    expect(status.status.clean).toBe(true);

    await fs.writeFile(path.join(dir, 'src', 'index.ts'), 'export const start = () => 3;\n');
    const dirty = await client.request<{ status: { clean: boolean; files: { path: string }[] } }>(
      'git.status',
    );
    expect(dirty.status.clean).toBe(false);
    expect(dirty.status.files.map((f) => f.path)).toContain('src/index.ts');

    const diff = await client.request<{ diff: string }>('git.diff');
    expect(diff.diff).toContain('=> 3');

    const log = await client.request<{ commits: { subject: string }[] }>('git.log', { limit: 5 });
    expect(log.commits[0]!.subject).toBe('Initial commit');

    const branches = await client.request<{ branches: { name: string; current: boolean }[] }>(
      'git.branches',
    );
    expect(branches.branches.find((b) => b.name === 'main')?.current).toBe(true);
  });

  it('refuses to switch branches over uncommitted work', async () => {
    const git = await gitAvailable();
    if (!git.available) return;

    const { client } = await harness();
    const dir = await sampleProject();
    const repo = new GitRepo(dir);
    await repo.git(['init', '--initial-branch=main']);
    await repo.git(['config', 'user.email', 'test@openpulse.local']);
    await repo.git(['config', 'user.name', 'OpenPulse Test']);
    await repo.add(['.']);
    await repo.commit('Initial commit');
    await repo.checkout('other', { create: true });
    await repo.checkout('main');
    await client.request('projects.add', { path: dir });

    await fs.writeFile(path.join(dir, 'README.md'), '# Work in progress\n');

    await expect(client.request('git.checkout', { branch: 'other' })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('uncommitted changes'),
    });
    await expect(fs.readFile(path.join(dir, 'README.md'), 'utf8')).resolves.toBe(
      '# Work in progress\n',
    );
  });
});

describe('security RPCs', () => {
  it('reports the enforced policy and switches mode', async () => {
    const { client } = await harness();

    const before = await client.request<{ mode: string; policy: { writeRoots: string[] } }>(
      'security.get',
    );
    expect(before.mode).toBe('balanced');
    expect(before.policy.writeRoots.length).toBeGreaterThan(0);

    const after = await client.request<{ mode: string; policy: { writeRoots: string[] } }>(
      'security.set',
      {
        mode: 'read-only',
      },
    );
    expect(after.mode).toBe('read-only');
    expect(after.policy.writeRoots).toEqual([]);
  });
});
