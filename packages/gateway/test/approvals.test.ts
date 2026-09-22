import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ExecApprovals, globMatch } from '../src/approvals/exec-approvals.js';
import { assessShellCommand } from '../src/policy/risk.js';
import { tempDir } from './helpers.js';

async function approvals(defaults: Record<string, unknown> = {}) {
  const file = path.join(await tempDir(), 'exec-approvals.json');
  const a = new ExecApprovals(file);
  await a.load();
  if (Object.keys(defaults).length)
    await a.set({ ...a.get(), defaults: { ...a.get().defaults, ...defaults } });
  return a;
}

describe('exec approvals policy', () => {
  it('blocks catastrophic commands whatever the mode', async () => {
    for (const mode of ['deny', 'allowlist', 'full'] as const) {
      const a = await approvals({ security: mode, ask: 'off' });
      const gate = a.evaluate('rm -rf /', 'main');
      expect(gate.action).toBe('deny');
      expect(gate.reason).toMatch(/blocked/);
    }
  });

  it('auto-allows read-only commands and asks for the rest (allowlist + on-miss)', async () => {
    const a = await approvals();
    expect(a.evaluate('ls -la', 'main').action).toBe('allow');
    expect(a.evaluate('git status', 'main').action).toBe('allow');
    expect(a.evaluate('rm notes.txt', 'main')).toMatchObject({ action: 'ask' });
    expect(a.evaluate('npm install left-pad', 'main').action).toBe('ask');
  });

  it('respects security and ask modes', async () => {
    const deny = await approvals({ security: 'deny' });
    expect(deny.evaluate('ls', 'main').action).toBe('deny');

    const full = await approvals({ security: 'full', ask: 'off' });
    expect(full.evaluate('rm notes.txt', 'main').action).toBe('allow');

    const always = await approvals({ security: 'full', ask: 'always' });
    expect(always.evaluate('ls', 'main').action).toBe('ask');

    const strict = await approvals({ security: 'allowlist', ask: 'off' });
    expect(strict.evaluate('rm notes.txt', 'main').action).toBe('deny');
  });

  it('matches allowlist patterns with globs and records usage', async () => {
    const a = await approvals();
    await a.addAllow('main', 'git push *');
    const gate = a.evaluate('git push origin main', 'main');
    expect(gate).toMatchObject({ action: 'allow', matched: 'git push *' });
    await a.touch('main', 'git push *', 'git push origin main');
    expect(a.get().agents.main!.allowlist[0]!.lastUsedCommand).toBe('git push origin main');

    await a.removeAllow('main', 'git push *');
    expect(a.evaluate('git push origin main', 'main').action).toBe('ask');
  });

  it('persists to disk and reloads', async () => {
    const a = await approvals();
    await a.addAllow('main', 'docker ps');
    const b = new ExecApprovals(a.file);
    await b.load();
    expect(b.get().agents.main!.allowlist.map((e) => e.pattern)).toEqual(['docker ps']);
    expect(JSON.parse(await fs.readFile(a.file, 'utf8'))).toMatchObject({ version: 1 });
  });
});

describe('approval requests', () => {
  const req = {
    command: 'rm -rf build',
    cwd: '/w',
    agentId: 'main',
    sessionKey: 'agent:main:main',
    risk: assessShellCommand('rm -rf build'),
  };

  it('resolves allow-once and notifies listeners', async () => {
    const a = await approvals();
    const requested = vi.fn();
    a.on('requested', requested);
    const pending = a.request(req);
    await vi.waitFor(() => expect(requested).toHaveBeenCalled());
    const id = requested.mock.calls[0]![0].id as string;
    expect(a.list()).toHaveLength(1);
    expect(a.resolve(id, 'allow-once', 'telegram:me')).toBe(true);
    expect(await pending).toMatchObject({ decision: 'allow-once', resolvedBy: 'telegram:me' });
    expect(a.resolve(id, 'deny', 'x')).toBe(false); // already decided
  });

  it('allow-always adds the command to the allowlist', async () => {
    const a = await approvals();
    const requested = vi.fn();
    a.on('requested', requested);
    const pending = a.request(req);
    await vi.waitFor(() => expect(requested).toHaveBeenCalled());
    a.resolve(requested.mock.calls[0]![0].id as string, 'allow-always', 'dashboard');
    await pending;
    await vi.waitFor(() =>
      expect(a.get().agents.main?.allowlist.map((e) => e.pattern)).toEqual(['rm -rf build']),
    );
    expect(a.evaluate('rm -rf build', 'main').action).toBe('allow');
  });

  it('times out and can be cancelled', async () => {
    const a = await approvals({ timeoutSeconds: 10 });
    vi.useFakeTimers();
    try {
      const pending = a.request(req);
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await pending).toMatchObject({ decision: 'timeout', resolvedBy: 'timeout' });
    } finally {
      vi.useRealTimers();
    }

    const controller = new AbortController();
    const cancelled = a.request(req, controller.signal);
    controller.abort();
    expect(await cancelled).toMatchObject({ decision: 'deny', resolvedBy: 'aborted' });
  });
});

describe('globMatch', () => {
  it('matches literal and wildcard patterns', () => {
    expect(globMatch('git status', 'git status')).toBe(true);
    expect(globMatch('git *', 'git push origin')).toBe(true);
    expect(globMatch('git *', 'gitk')).toBe(false);
    expect(globMatch('*/bin/rg', '/usr/bin/rg')).toBe(true);
    expect(globMatch('a.b', 'aXb')).toBe(false);
  });
});
