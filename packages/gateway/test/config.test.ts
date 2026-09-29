import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ConfigError,
  ConfigStore,
  getPath,
  mergePatch,
  patchForPath,
} from '../src/config/store.js';
import { parseDurationMs } from '../src/config/schema.js';
import { FALLBACK_VERSION, VERSION } from '../src/version.js';
import { tempDir } from './helpers.js';

async function store(text?: string, env: NodeJS.ProcessEnv = {}) {
  const dir = await tempDir();
  const file = path.join(dir, 'openpulse.json');
  if (text !== undefined) await fs.writeFile(file, text);
  const s = new ConfigStore(file, env);
  await s.load();
  return s;
}

describe('ConfigStore', () => {
  it('uses defaults when the file is missing', async () => {
    const s = await store();
    expect(s.get().exists).toBe(false);
    expect(s.config.gateway.port).toBe(18789);
    expect(s.config.agents.defaults.model.primary).toBe('anthropic/claude-opus-5');
    expect(s.config.agents.defaults.heartbeat).toMatchObject({
      every: '30m',
      target: 'last',
      ackMaxChars: 300,
    });
    expect(s.config.session.dmScope).toBe('main');
    expect(s.config.channels.telegram).toBeUndefined();
  });

  it('reads JSON5 with comments and trailing commas', async () => {
    const s = await store(`{
      // the model to think with
      agents: { defaults: { model: { primary: 'openai/gpt-5' } } },
      gateway: { port: 19000 },
    }`);
    expect(s.get().valid).toBe(true);
    expect(s.config.agents.defaults.model.primary).toBe('openai/gpt-5');
    expect(s.config.gateway.port).toBe(19000);
  });

  it('rejects unknown keys and bad values without crashing', async () => {
    const s = await store('{ gateway: { port: 99999 }, nope: 1 }');
    const snap = s.get();
    expect(snap.valid).toBe(false);
    expect(snap.issues.map((i) => i.path)).toContain('gateway.port');
    expect(snap.issues.map((i) => i.message).join(' ')).toMatch(/nope/); // unknown key reported at the root
    expect(s.config.gateway.port).toBe(18789); // falls back to defaults
  });

  it('reports JSON5 syntax errors', async () => {
    const s = await store('{ gateway: { port: }');
    expect(s.get().valid).toBe(false);
    expect(s.get().issues[0]!.message).toMatch(/JSON5 parse error/);
  });

  it('substitutes ${ENV} references and fails loudly when missing', async () => {
    const s = await store('{ gateway: { auth: { token: "${OP_TOKEN}" } } }', {
      OP_TOKEN: 'sekret',
    });
    expect(s.config.gateway.auth.token).toBe('sekret');
    const missing = await store('{ gateway: { auth: { token: "${NOPE}" } } }', {});
    expect(missing.get().issues[0]!.message).toMatch(/Missing environment variable \$\{NOPE\}/);
  });

  it('merge-patches, preserves other keys and guards on the base hash', async () => {
    const s = await store(
      '{ agents: { defaults: { model: { primary: "anthropic/claude-opus-5" } } } }',
    );
    const before = s.get().hash;
    await s.patch({ channels: { telegram: { enabled: true, botToken: '123:abc' } } }, before);
    expect(s.config.channels.telegram).toMatchObject({
      enabled: true,
      botToken: '123:abc',
      dmPolicy: 'pairing',
    });
    expect(s.config.agents.defaults.model.primary).toBe('anthropic/claude-opus-5');

    await expect(s.patch({ gateway: { port: 1 } }, before)).rejects.toThrow(ConfigError);
    await s.patch({ channels: { telegram: { botToken: null } } });
    expect(s.config.channels.telegram?.botToken).toBeUndefined();
  });

  it('refuses invalid writes and leaves the file untouched', async () => {
    const s = await store('{}');
    const before = await fs.readFile(s.path, 'utf8');
    await expect(s.set('{ gateway: { bind: "satellite" } }')).rejects.toThrow(/Config is invalid/);
    expect(await fs.readFile(s.path, 'utf8')).toBe(before);
  });

  it('creates a file with a generated gateway token on first run', async () => {
    const dir = await tempDir();
    const s = new ConfigStore(path.join(dir, 'openpulse.json'), {});
    await s.ensure();
    expect(s.config.gateway.auth.mode).toBe('token');
    expect(s.config.gateway.auth.token).toMatch(/^[0-9a-f]{48}$/);
    const again = new ConfigStore(s.path, {});
    expect((await again.load()).config.gateway.auth.token).toBe(s.config.gateway.auth.token);
  });

  it('emits a change event when the file is edited externally', async () => {
    const s = await store('{}');
    s.watch();
    const onChange = vi.fn();
    s.on('change', onChange);
    await fs.writeFile(s.path, '{ logging: { level: "debug" } }');
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 5000 });
    expect(s.config.logging.level).toBe('debug');
    s.unwatch();
  });
});

describe('config helpers', () => {
  it('merge-patches deeply with null deleting keys', () => {
    expect(mergePatch({ a: { b: 1, c: 2 } }, { a: { c: null, d: 3 } })).toEqual({
      a: { b: 1, d: 3 },
    });
    expect(mergePatch({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] });
  });

  it('reads and builds dotted paths', () => {
    expect(getPath({ a: { b: { c: 7 } } }, 'a.b.c')).toBe(7);
    expect(getPath({ a: 1 }, 'a.b')).toBeUndefined();
    expect(patchForPath('channels.telegram.enabled', true)).toEqual({
      channels: { telegram: { enabled: true } },
    });
  });

  it('parses durations', () => {
    expect(parseDurationMs('30m')).toBe(1_800_000);
    expect(parseDurationMs('2h')).toBe(7_200_000);
    expect(parseDurationMs('0m')).toBe(0);
    expect(() => parseDurationMs('soon')).toThrow();
  });
});

describe('version', () => {
  it('matches package.json, including the value compiled into bundles', async () => {
    const pkg = JSON.parse(
      await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);
    expect(FALLBACK_VERSION).toBe(pkg.version);
  });
});
