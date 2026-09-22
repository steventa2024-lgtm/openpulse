import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startGateway, type RunningGateway } from '@openpulse/gateway';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProgram, type CliIO } from '../src/index.js';

const gateways: RunningGateway[] = [];
const dirs: string[] = [];
let previousStateDir: string | undefined;

afterEach(async () => {
  for (const g of gateways.splice(0)) await g.stop();
  if (previousStateDir === undefined) delete process.env.OPENPULSE_STATE_DIR;
  else process.env.OPENPULSE_STATE_DIR = previousStateDir;
  await Promise.all(
    dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true, maxRetries: 5 })),
  );
});

beforeEach(() => {
  process.exitCode = undefined;
  previousStateDir = process.env.OPENPULSE_STATE_DIR;
});

function captureIO(): CliIO & { stdout: string[]; stderr: string[]; text: () => string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    text: () => stdout.join('\n'),
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
  };
}

async function run(io: CliIO, ...args: string[]): Promise<void> {
  const program = createProgram(io).exitOverride();
  // Subcommands copy settings at creation time, so the override must be applied to each level.
  const apply = (command: ReturnType<typeof createProgram>) => {
    for (const child of command.commands) {
      child.exitOverride();
      apply(child);
    }
  };
  apply(program);
  await program.parseAsync(args, { from: 'user' });
}

/** A gateway on a throwaway state dir, with that state dir also exported for the CLI. */
async function gateway(config: Record<string, unknown> = {}): Promise<RunningGateway> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openpulse-cli-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.openpulse');
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    path.join(stateDir, 'openpulse.json'),
    JSON.stringify(
      {
        gateway: { auth: { mode: 'token', token: 'test-token' } },
        agents: { defaults: { heartbeat: { every: '0m' } } },
        ...config,
      },
      null,
      2,
    ),
  );
  const g = await startGateway({
    stateDir,
    env: {},
    port: 0,
    controlUiDir: false,
    channels: false,
    cron: false,
    heartbeat: false,
  });
  gateways.push(g);
  process.env.OPENPULSE_STATE_DIR = stateDir;
  return g;
}

describe('openpulse CLI', () => {
  it('prints its version', async () => {
    const io = captureIO();
    await expect(run(io, '--version')).rejects.toMatchObject({ code: 'commander.version' });
    expect(io.text()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('rejects an invalid port', async () => {
    const io = captureIO();
    await expect(run(io, 'gateway', 'run', '--port', 'nope')).rejects.toMatchObject({
      code: 'commander.invalidArgument',
    });
  });

  it('explains how to start the gateway when it is unreachable', async () => {
    const io = captureIO();
    await expect(run(io, 'status', '--url', 'http://127.0.0.1:1')).rejects.toMatchObject({
      message: expect.stringContaining('openpulse gateway'),
    });
  });

  it('creates the workspace with setup', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openpulse-cli-'));
    dirs.push(dir);
    process.env.OPENPULSE_STATE_DIR = path.join(dir, '.openpulse');
    const io = captureIO();
    await run(io, 'setup', '--workspace', path.join(dir, 'workspace'));
    expect(io.text()).toContain('AGENTS.md');
    await expect(fs.readFile(path.join(dir, 'workspace', 'AGENTS.md'), 'utf8')).resolves.toContain(
      '#',
    );
  });

  describe('against a running gateway', () => {
    it('reports status and health', async () => {
      const g = await gateway();
      const io = captureIO();
      await run(io, 'status', '--url', g.url);
      expect(io.text()).toContain('agent:main:main');
      expect(io.text()).toContain('state dir');

      const healthIO = captureIO();
      await run(healthIO, 'health', '--url', g.url, '--json');
      expect(JSON.parse(healthIO.text())).toMatchObject({ ok: true });
    });

    it('lists sessions', async () => {
      const g = await gateway();
      const io = captureIO();
      await run(io, 'sessions', 'list', '--url', g.url);
      expect(io.text()).toContain('no sessions yet');
    });

    it('adds, lists and removes cron jobs', async () => {
      const g = await gateway();
      const add = captureIO();
      await run(
        add,
        'cron',
        'add',
        'nightly',
        '--cron',
        '0 9 * * *',
        '--isolated',
        '--message',
        'Summarise the day.',
        '--url',
        g.url,
        '--json',
      );
      const job = JSON.parse(add.text()) as { jobId: string };
      expect(job.jobId).toBeTruthy();

      const list = captureIO();
      await run(list, 'cron', 'list', '--url', g.url);
      expect(list.text()).toContain('nightly');
      expect(list.text()).toContain('cron 0 9 * * *');

      const rm = captureIO();
      await run(rm, 'cron', 'rm', job.jobId, '--url', g.url);
      expect(rm.text()).toContain('removed');

      const empty = captureIO();
      await run(empty, 'cron', 'list', '--url', g.url);
      expect(empty.text()).toContain('no cron jobs');
    });

    it('reads and writes config paths', async () => {
      const g = await gateway();
      const set = captureIO();
      await run(set, 'config', 'set', 'agents.defaults.heartbeat.every', '"45m"', '--url', g.url);
      expect(set.text()).toContain('45m');

      const get = captureIO();
      await run(get, 'config', 'get', 'agents.defaults.heartbeat.every', '--url', g.url);
      expect(get.text()).toBe('45m');
    });

    it('rejects an unknown config path', async () => {
      const g = await gateway();
      const io = captureIO();
      await expect(run(io, 'config', 'get', 'nope.not.here', '--url', g.url)).rejects.toMatchObject(
        { message: expect.stringContaining('No such config path') },
      );
    });

    it('lists skills with their requirement state', async () => {
      const g = await gateway();
      const io = captureIO();
      await run(io, 'skills', 'list', '--url', g.url);
      expect(io.text()).toMatch(/SKILL\s+SOURCE/);
    });

    it('shows the approval policy', async () => {
      const g = await gateway();
      const io = captureIO();
      await run(io, 'approvals', 'get', '--url', g.url);
      expect(io.text()).toContain('security');
    });

    it('reports pairing state for a channel', async () => {
      const g = await gateway();
      const io = captureIO();
      await run(io, 'pairing', 'list', 'telegram', '--url', g.url);
      expect(io.text()).toContain('no pending pairing requests');
    });

    it('runs doctor and reports the gateway as reachable', async () => {
      const g = await gateway();
      const io = captureIO();
      await run(io, 'doctor', '--url', g.url, '--json');
      const { checks } = JSON.parse(io.text()) as { checks: { label: string; ok: boolean }[] };
      expect(checks.find((x) => x.label === 'gateway')?.ok).toBe(true);
      expect(checks.find((x) => x.label === 'config valid')?.ok).toBe(true);
    });

    it('tails logs', async () => {
      const g = await gateway();
      const io = captureIO();
      await run(io, 'logs', '-n', '20', '--url', g.url);
      expect(io.stdout.length).toBeGreaterThan(0);
    });

    it('calls an RPC method directly', async () => {
      const g = await gateway();
      const io = captureIO();
      await run(io, 'gateway', 'call', 'sessions.list', '{ limit: 5 }', '--url', g.url);
      expect(JSON.parse(io.text())).toMatchObject({ sessions: [] });
    });
  });
});
