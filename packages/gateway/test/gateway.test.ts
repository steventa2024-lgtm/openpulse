import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayClient, GatewayClientError } from '../src/client/gateway-client.js';
import { createIdentity } from '../src/client/identity.js';
import { startGateway, type RunningGateway } from '../src/start.js';
import { PROTOCOL_VERSION } from '../src/gateway/protocol.js';
import { makeRuntime, tempDir } from './helpers.js';
import { scriptedModel, type ScriptedStep } from './llm-helpers.js';

const gateways: RunningGateway[] = [];
const clients: GatewayClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const g of gateways.splice(0)) await g.stop();
});

async function gateway(steps: ScriptedStep[] = [], config: Record<string, unknown> = {}) {
  const stateDir = path.join(await tempDir(), '.openpulse');
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
  const script = scriptedModel(steps);
  const g = await startGateway({
    stateDir,
    env: {},
    modelFactory: script.factory,
    port: 0,
    controlUiDir: false,
    channels: false,
    cron: false,
    heartbeat: false,
  });
  gateways.push(g);
  return { g, script, stateDir };
}

async function connect(
  g: RunningGateway,
  options: Partial<ConstructorParameters<typeof GatewayClient>[0]> = {},
) {
  const client = new GatewayClient({
    url: g.url,
    token: 'test-token',
    clientId: 'test-cli',
    mode: 'cli',
    ...options,
  });
  clients.push(client);
  await client.connect();
  return client;
}

describe('gateway handshake', () => {
  it('challenges, accepts a valid token and returns hello-ok', async () => {
    const { g } = await gateway();
    const client = await connect(g);
    const hello = client.hello!;
    expect(hello.protocol).toBe(PROTOCOL_VERSION);
    expect(hello.server.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(hello.features.methods).toEqual(
      expect.arrayContaining([
        'health',
        'chat.send',
        'sessions.list',
        'cron.list',
        'config.get',
        'logs.tail',
      ]),
    );
    expect(hello.features.events).toEqual(
      expect.arrayContaining(['chat', 'agent', 'heartbeat', 'cron', 'exec.approval.requested']),
    );
    expect(hello.snapshot.sessionDefaults).toMatchObject({ mainSessionKey: 'agent:main:main' });
    expect(hello.policy.tickIntervalMs).toBeGreaterThan(0);
  });

  it('rejects a wrong token and a missing one', async () => {
    const { g } = await gateway();
    await expect(connect(g, { token: 'nope' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(connect(g, { token: undefined })).rejects.toBeInstanceOf(GatewayClientError);
  });

  it('auto-approves loopback devices and issues a device token that works on its own', async () => {
    const { g } = await gateway();
    const identity = createIdentity();
    const first = await connect(g, { identity });
    expect(first.hello!.auth.deviceToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    const paired = await g.runtime.devices.listPaired();
    expect(paired.map((d) => d.deviceId)).toEqual([identity.deviceId]);

    const second = await connect(g, {
      identity,
      token: undefined,
      deviceToken: first.hello!.auth.deviceToken,
    });
    expect(second.connected).toBe(true);
  });

  it('rejects a forged device signature', async () => {
    const { g } = await gateway();
    const identity = createIdentity();
    const other = createIdentity();
    await expect(
      connect(g, { identity: { ...identity, privateKey: other.privateKey } }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('gateway methods', () => {
  it('serves health and status', async () => {
    const { g } = await gateway();
    const client = await connect(g);
    const health = await client.request<Record<string, unknown>>('health');
    expect(health).toMatchObject({ ok: true, configValid: true });
    const status = await client.request<Record<string, unknown>>('status');
    expect(status).toMatchObject({
      mainSessionKey: 'agent:main:main',
      model: 'anthropic/claude-opus-5',
      stateDir: g.runtime.paths.stateDir,
    });
    expect(await client.request('system-presence')).toMatchObject({
      presence: expect.arrayContaining([expect.objectContaining({ mode: 'gateway' })]),
    });
  });

  it('runs a chat turn and streams chat + agent events', async () => {
    const { g } = await gateway([{ text: 'Hi there!' }]);
    const client = await connect(g);
    const events: { event: string; payload: any }[] = [];
    client.on('event', (e) => events.push(e as { event: string; payload: any }));

    const sent = await client.request<{ runId: string; status: string }>('chat.send', {
      sessionKey: 'main',
      message: 'hello',
    });
    expect(sent.status).toBe('started');

    await vi.waitFor(() =>
      expect(events.some((e) => e.event === 'chat' && e.payload.state === 'final')).toBe(true),
    );
    const final = events.find((e) => e.event === 'chat' && e.payload.state === 'final')!;
    expect(final.payload.message.content[0].text).toBe('Hi there!');
    expect(events.filter((e) => e.event === 'agent').length).toBeGreaterThan(1);

    const history = await client.request<{ messages: { role: string }[] }>('chat.history', {
      sessionKey: 'main',
    });
    expect(history.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('handles chat commands and injects notes', async () => {
    const { g } = await gateway();
    const client = await connect(g);
    expect(
      await client.request('chat.send', { sessionKey: 'main', message: '/status' }),
    ).toMatchObject({ command: true });
    await client.request('chat.inject', { sessionKey: 'main', message: 'note to self' });
    const history = await client.request<{ messages: { role: string; injected?: boolean }[] }>(
      'chat.history',
      { sessionKey: 'main' },
    );
    expect(history.messages.filter((m) => m.injected)).toHaveLength(2); // command reply + injected note
  });

  it('lists, patches and resets sessions', async () => {
    const { g } = await gateway([{ text: 'ok' }]);
    const client = await connect(g);
    await client.request('chat.send', { sessionKey: 'main', message: 'hi' });
    await vi.waitFor(async () =>
      expect(
        (await client.request<{ sessions: unknown[] }>('sessions.list')).sessions.length,
      ).toBeGreaterThan(0),
    );

    await client.request('sessions.patch', {
      key: 'main',
      thinkingLevel: 'high',
      model: 'openai/gpt-5',
    });
    const list = await client.request<{
      sessions: { key: string; thinkingLevel: string; modelOverride: string }[];
      defaults: { mainSessionKey: string };
    }>('sessions.list');
    expect(list.sessions[0]).toMatchObject({
      key: 'agent:main:main',
      thinkingLevel: 'high',
      modelOverride: 'openai/gpt-5',
    });
    expect(list.defaults.mainSessionKey).toBe('agent:main:main');

    const before = list.sessions[0] as unknown as { sessionId: string };
    const reset = await client.request<{ sessionId: string }>('sessions.reset', { key: 'main' });
    expect(reset.sessionId).not.toBe(before.sessionId);
    await expect(client.request('sessions.delete', { key: 'main' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });

  it('edits config with a base-hash guard and reports invalid config', async () => {
    const { g } = await gateway();
    const client = await connect(g);
    const snap = await client.request<{ raw: string; hash: string; valid: boolean }>('config.get');
    expect(snap.valid).toBe(true);

    await client.request('config.patch', {
      patch: { logging: { level: 'debug' } },
      baseHash: snap.hash,
    });
    expect(g.runtime.cfg.logging.level).toBe('debug');
    await expect(
      client.request('config.patch', {
        patch: { logging: { level: 'warn' } },
        baseHash: snap.hash,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      client.request('config.set', { raw: '{ gateway: { bind: "moon" } }' }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

    const schema = await client.request<{ schema: unknown; uiHints: Record<string, unknown> }>(
      'config.schema',
    );
    expect(schema.schema).toBeTruthy();
    expect(schema.uiHints['channels.telegram.botToken']).toMatchObject({ sensitive: true });
  });

  it('exposes cron, skills, approvals, devices and logs', async () => {
    const { g } = await gateway();
    const client = await connect(g);

    const job = await client.request<{ jobId: string }>('cron.add', {
      job: {
        name: 'brief',
        schedule: { kind: 'cron', expr: '0 7 * * *' },
        sessionTarget: 'main',
        payload: { kind: 'systemEvent', text: 'brief' },
      },
    });
    expect((await client.request<{ jobs: unknown[] }>('cron.list')).jobs).toHaveLength(1);
    await client.request('cron.remove', { jobId: job.jobId });
    await expect(client.request('cron.run', { jobId: 'nope' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    const skills = await client.request<{ skills: { name: string; eligible: boolean }[] }>(
      'skills.status',
    );
    expect(skills.skills.map((s) => s.name)).toEqual(
      expect.arrayContaining(['weather', 'system-info']),
    );
    await client.request('skills.update', { name: 'weather', enabled: false });
    expect(g.runtime.cfg.skills.entries.weather).toMatchObject({ enabled: false });

    expect(await client.request('exec.approvals.get')).toMatchObject({
      file: { defaults: { security: 'allowlist', ask: 'on-miss' } },
    });
    expect(await client.request('device.pair.list')).toMatchObject({ pending: [], paired: [] });

    g.runtime.log.info('a log line for the tail');
    const tail = await client.request<{ lines: string[]; cursor: number }>('logs.tail', {
      limit: 50,
    });
    expect(tail.lines.some((l) => l.includes('a log line for the tail'))).toBe(true);
    expect(tail.cursor).toBeGreaterThan(0);
  });

  it('reads and writes agent workspace files', async () => {
    const { g } = await gateway();
    const client = await connect(g);
    const list = await client.request<{ files: { name: string; exists: boolean }[] }>(
      'agents.files.list',
    );
    expect(list.files.find((f) => f.name === 'AGENTS.md')).toMatchObject({ exists: true });
    await client.request('agents.files.set', {
      name: 'USER.md',
      content: '# USER.md\n\n- Name: Steve\n',
    });
    expect(await client.request('agents.files.get', { name: 'USER.md' })).toMatchObject({
      content: '# USER.md\n\n- Name: Steve\n',
    });
    await expect(client.request('agents.files.get', { name: 'secrets.txt' })).rejects.toMatchObject(
      { code: 'INVALID_REQUEST' },
    );
  });

  it('rejects unknown methods', async () => {
    const { g } = await gateway();
    const client = await connect(g);
    await expect(client.request('nope.nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('gateway http', () => {
  it('serves /health and a placeholder when the Control UI is not built', async () => {
    const { g } = await gateway();
    const health = await fetch(`${g.url}/health`);
    expect(await health.json()).toMatchObject({ ok: true });
    const page = await fetch(`${g.url}/`);
    expect(await page.text()).toMatch(/Control UI has not been built/);
  });

  it('serves the built Control UI with SPA fallback', async () => {
    const dist = await tempDir();
    await fs.writeFile(
      path.join(dist, 'index.html'),
      '<!doctype html><title>OpenPulse Control UI</title>',
    );
    await fs.writeFile(path.join(dist, 'app.js'), 'console.log(1)');
    const stateDir = path.join(await tempDir(), '.openpulse');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, 'openpulse.json'),
      JSON.stringify({ gateway: { auth: { mode: 'none' } } }),
    );
    const g = await startGateway({
      stateDir,
      env: {},
      port: 0,
      controlUiDir: dist,
      channels: false,
      cron: false,
      heartbeat: false,
    });
    gateways.push(g);

    expect(await (await fetch(`${g.url}/`)).text()).toContain('OpenPulse Control UI');
    expect(await (await fetch(`${g.url}/chat`)).text()).toContain('OpenPulse Control UI'); // SPA fallback
    const js = await fetch(`${g.url}/app.js`);
    expect(js.headers.get('content-type')).toBe('text/javascript');
  });
});

describe('runtime wiring', () => {
  it('starts and stops cleanly with everything enabled', async () => {
    const { rt } = await makeRuntime([], {
      config: { agents: { defaults: { heartbeat: { every: '30m' } } } },
    });
    await rt.start();
    expect(rt.heartbeat.nextRunAt()).toBeGreaterThan(Date.now());
    expect(rt.cron.status().enabled).toBe(true);
    await rt.stop();
    expect(rt.heartbeat.nextRunAt()).toBeUndefined();
  });
});
