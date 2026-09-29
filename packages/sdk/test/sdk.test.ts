import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startGateway, type RunningGateway } from '@openpulse/gateway';
import {
  createDeviceIdentity,
  OpenPulseClient,
  OpenPulseError,
  type TaskUpdate,
} from '../src/index.js';

/**
 * These tests run the SDK against a real gateway. The only thing replaced is the language model:
 * a scripted one stands in for Ollama or Anthropic so replies are deterministic.
 */

const gateways: RunningGateway[] = [];
const clients: OpenPulseClient[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const gateway of gateways.splice(0)) await gateway.stop();
  await Promise.all(
    dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true, maxRetries: 5 })),
  );
});

interface Step {
  text?: string;
  toolCalls?: { name: string; input: unknown }[];
}

/** A minimal AI SDK v4-spec model that replays scripted steps. */
function scriptedModel(steps: Step[]) {
  let call = 0;
  const model = {
    specificationVersion: 'v4',
    provider: 'scripted',
    modelId: 'scripted',
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error('streaming only')),
    doStream: () => {
      const step = steps[Math.min(call, steps.length - 1)] ?? { text: '' };
      call += 1;
      const parts: unknown[] = [{ type: 'stream-start', warnings: [] }];
      if (step.text) {
        parts.push({ type: 'text-start', id: 't' });
        for (const piece of step.text.match(/.{1,6}/gs) ?? [])
          parts.push({ type: 'text-delta', id: 't', delta: piece });
        parts.push({ type: 'text-end', id: 't' });
      }
      (step.toolCalls ?? []).forEach((tc, i) =>
        parts.push({
          type: 'tool-call',
          toolCallId: `c${call}_${i}`,
          toolName: tc.name,
          input: JSON.stringify(tc.input),
        }),
      );
      parts.push({
        type: 'finish',
        finishReason: { unified: step.toolCalls?.length ? 'tool-calls' : 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 12 }, outputTokens: { total: 7 } },
      });
      return Promise.resolve({
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      });
    },
  };
  return () => model as never;
}

async function gateway(steps: Step[] = [{ text: 'Hello from the gateway.' }]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openpulse-sdk-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.openpulse');
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    path.join(stateDir, 'openpulse.json'),
    JSON.stringify({
      gateway: { auth: { mode: 'token', token: 'sdk-test-token' } },
      agents: { defaults: { heartbeat: { every: '0m' } } },
    }),
  );
  const running = await startGateway({
    stateDir,
    env: {},
    port: 0,
    controlUiDir: false,
    channels: false,
    cron: false,
    heartbeat: false,
    mcp: false,
    modelFactory: scriptedModel(steps),
  });
  gateways.push(running);
  return running;
}

async function connect(url: string, token = 'sdk-test-token') {
  const client = await OpenPulseClient.connect({ url, token, clientName: 'SDK test' });
  clients.push(client);
  return client;
}

describe('connecting', () => {
  it('connects with a token and reports the gateway', async () => {
    const g = await gateway();
    const op = await connect(g.url);

    expect(op.connected).toBe(true);
    expect(op.hello.protocol).toBe(3);
    expect(op.supports('chat.send')).toBe(true);
    expect(op.supports('workflows.start')).toBe(true);
    await expect(op.health()).resolves.toMatchObject({ ok: true });
  });

  it('rejects a wrong token with an OpenPulseError', async () => {
    const g = await gateway();
    await expect(OpenPulseClient.connect({ url: g.url, token: 'wrong' })).rejects.toMatchObject({
      name: 'OpenPulseError',
      code: 'UNAUTHORIZED',
    });
  });

  it('fails clearly when nothing is listening', async () => {
    await expect(
      OpenPulseClient.connect({ url: 'http://127.0.0.1:1', timeoutMs: 3_000 }),
    ).rejects.toBeInstanceOf(OpenPulseError);
  });

  it('connects with a device identity', async () => {
    const g = await gateway();
    const { identity } = await createDeviceIdentity();
    const op = await OpenPulseClient.connect({ url: g.url, token: 'sdk-test-token', identity });
    clients.push(op);

    expect(identity.deviceId).toMatch(/^[0-9a-f]{32}$/);
    expect(op.connected).toBe(true);
  });

  it('refuses requests after close', async () => {
    const g = await gateway();
    const op = await connect(g.url);
    await op.close();
    await expect(op.health()).rejects.toMatchObject({ code: 'CLOSED' });
  });
});

describe('agent tasks', () => {
  it('runs a turn and returns the answer', async () => {
    const g = await gateway([{ text: 'The answer is 42.' }]);
    const op = await connect(g.url);

    const result = await op.run('What is the answer?');
    expect(result.text).toBe('The answer is 42.');
    expect(result.aborted).toBe(false);
    expect(result.usage).toMatchObject({ input: 12, output: 7 });
  });

  it('streams text, tool calls and the final answer', async () => {
    const g = await gateway([
      { toolCalls: [{ name: 'read', input: { path: 'AGENTS.md' } }] },
      { text: 'I read the house rules.' },
    ]);
    const op = await connect(g.url);

    const updates: TaskUpdate[] = [];
    for await (const update of op.runTask('Read AGENTS.md')) updates.push(update);

    const types = updates.map((u) => u.type);
    expect(types).toContain('tool');
    expect(types).toContain('text');
    expect(types[types.length - 1]).toBe('done');

    const text = updates
      .filter((u): u is Extract<TaskUpdate, { type: 'text' }> => u.type === 'text')
      .map((u) => u.delta)
      .join('');
    expect(text).toBe('I read the house rules.');
    expect(updates.find((u) => u.type === 'tool')).toMatchObject({ name: 'read', phase: 'start' });
  });

  it('lists sessions and reads history after a task', async () => {
    const g = await gateway([{ text: 'Noted.' }]);
    const op = await connect(g.url);
    await op.run('Remember this.');

    const sessions = await op.sessions.list();
    expect(sessions.map((s) => s.key)).toContain('agent:main:main');
    const history = await op.sessions.history('main');
    expect(history.messages.some((m) => m.role === 'assistant')).toBe(true);
  });

  it('inspects the finished run through the debugger', async () => {
    const g = await gateway([{ text: 'Done.' }]);
    const op = await connect(g.url);
    const result = await op.run('Do something');

    const runs = await op.runs.list();
    expect(runs[0]).toMatchObject({ runId: result.runId, status: 'ok' });
    const trace = await op.runs.trace(result.runId);
    expect(trace).toMatchObject({ runId: result.runId });
  });
});

describe('inspection', () => {
  it('lists models and tools', async () => {
    const g = await gateway();
    const op = await connect(g.url);

    const models = await op.models.list();
    expect(models.primary).toBeTruthy();

    const tools = await op.tools.list();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['read', 'write', 'exec', 'propose_change']),
    );
    expect(tools.every((t) => t.source === 'builtin')).toBe(true);
  });

  it('surfaces gateway errors with their codes', async () => {
    const g = await gateway();
    const op = await connect(g.url);
    await expect(op.request('no.such.method')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(op.workflows.get('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('workflows', () => {
  it('starts a workflow and waits for it to finish', async () => {
    const g = await gateway([
      { text: 'Code findings.' },
      { text: 'Context findings.' },
      { text: 'The plan.' },
    ]);
    const op = await connect(g.url);

    const started = await op.workflows.start('research-then-plan', 'Add caching');
    const seen: string[] = [];
    const finished = await op.workflows.wait(started.id, (execution) =>
      seen.push(execution.status),
    );

    expect(finished.status).toBe('done');
    expect(finished.steps.map((s) => s.status)).toEqual(['done', 'done', 'done']);
    expect(seen.length).toBeGreaterThan(0);
  });
});
