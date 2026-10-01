import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { sanitizeText, sanitizeValue } from '../src/debug/sanitize.js';
import { TraceRecorder } from '../src/debug/trace.js';
import type { AgentEvent } from '../src/agent/runner.js';
import { makeRuntime, tempDir } from './helpers.js';

let seq = 0;
function event(
  runId: string,
  stream: AgentEvent['stream'],
  data: Record<string, unknown>,
): AgentEvent {
  seq += 1;
  return { runId, sessionKey: 'agent:main:main', seq, stream, ts: Date.now() + seq, data };
}

describe('secret redaction', () => {
  it('redacts provider keys, tokens and private keys', () => {
    const text = [
      'ANTHROPIC key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123',
      'OPENAI sk-proj-abcdefghijklmnopqrstuvwxyz012345',
      'gh token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz.012345',
      'postgres://admin:hunter2secret@db.internal:5432/app',
      'export DATABASE_PASSWORD="correct-horse-battery"',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
    ].join('\n');

    const clean = sanitizeText(text);
    expect(clean).not.toContain('sk-ant-api03');
    expect(clean).not.toContain('sk-proj-');
    expect(clean).not.toContain('ghp_');
    expect(clean).not.toContain('abcdefghijklmnopqrstuvwxyz.012345');
    expect(clean).not.toContain('hunter2secret');
    expect(clean).not.toContain('correct-horse-battery');
    expect(clean).not.toContain('MIIEowIBAAKCAQEA');
    expect(clean).toContain('postgres://admin:[redacted]@db.internal');
  });

  it('redacts exact known secrets even when they match no pattern', () => {
    expect(sanitizeText('token is plain-looking-value-9', ['plain-looking-value-9'])).toBe(
      'token is [redacted]',
    );
  });

  it('redacts secret-named fields in nested objects', () => {
    const clean = sanitizeValue({
      command: 'curl example.com',
      env: { API_KEY: 'abcdef123456', PATH: '/usr/bin' },
      headers: [{ authorization: 'Basic xyz' }],
    }) as { command: string; env: Record<string, string>; headers: { authorization: string }[] };

    expect(clean.command).toBe('curl example.com');
    expect(clean.env.API_KEY).toBe('[redacted]');
    expect(clean.env.PATH).toBe('/usr/bin');
    expect(clean.headers[0]!.authorization).toBe('[redacted]');
  });

  it('leaves ordinary text alone', () => {
    const text = 'Refactored login() to return early when the token has expired.';
    expect(sanitizeText(text)).toBe(text);
  });
});

describe('trace recorder', () => {
  it('builds a timeline from real agent events', () => {
    const traces = new TraceRecorder();
    traces.record(event('run-1', 'lifecycle', { phase: 'start', model: 'ollama/qwen3:8b' }));
    traces.record(event('run-1', 'thinking', { delta: 'I should read ' }));
    traces.record(event('run-1', 'thinking', { delta: 'the file.' }));
    traces.record(
      event('run-1', 'tool', {
        phase: 'start',
        toolCallId: 't1',
        name: 'read',
        summary: 'read src/auth.ts',
        args: { path: 'src/auth.ts' },
      }),
    );
    traces.record(
      event('run-1', 'tool', {
        phase: 'result',
        toolCallId: 't1',
        name: 'read',
        result: 'export function login() {}',
        durationMs: 12,
      }),
    );
    traces.record(event('run-1', 'assistant', { delta: 'The login ' }));
    traces.record(event('run-1', 'assistant', { delta: 'function is fine.' }));
    traces.record(
      event('run-1', 'lifecycle', {
        phase: 'end',
        usage: { input: 100, output: 20 },
        toolCalls: 1,
      }),
    );

    const trace = traces.get('run-1')!;
    expect(trace.status).toBe('ok');
    expect(trace.model).toBe('ollama/qwen3:8b');
    expect(trace.toolCalls).toBe(1);
    expect(trace.usage).toMatchObject({ input: 100, output: 20 });
    expect(trace.events.map((e) => e.kind)).toEqual([
      'run.start',
      'thinking',
      'tool.start',
      'tool.result',
      'assistant',
      'run.end',
    ]);
    // Streaming deltas are folded into one event per step.
    expect(trace.events.find((e) => e.kind === 'thinking')!.data!.text).toBe(
      'I should read the file.',
    );
    expect(trace.events.find((e) => e.kind === 'assistant')!.data!.text).toBe(
      'The login function is fine.',
    );
    expect(trace.events.find((e) => e.kind === 'tool.result')!.durationMs).toBe(12);
  });

  it('keeps finished runs across a restart', async () => {
    const dir = await tempDir();
    const before = new TraceRecorder({ dir });
    before.record(event('kept', 'lifecycle', { phase: 'start', model: 'ollama/qwen3:8b' }));
    before.record(event('kept', 'lifecycle', { phase: 'end', usage: { input: 5, output: 2 } }));
    before.record(event('failed', 'lifecycle', { phase: 'start' }));
    before.record(event('failed', 'lifecycle', { phase: 'error', error: 'model went away' }));
    // Persisting is fire-and-forget; wait for both lines to reach the file.
    await vi.waitFor(async () => {
      const files = await fs.readdir(dir);
      const text = await fs.readFile(path.join(dir, files[0]!), 'utf8');
      expect(text.trim().split('\n')).toHaveLength(2);
    });
    await fs.appendFile(path.join(dir, (await fs.readdir(dir))[0]!), '{"torn line');

    const after = new TraceRecorder({ dir });
    await after.load();
    expect(after.get('kept')).toMatchObject({
      status: 'ok',
      model: 'ollama/qwen3:8b',
      usage: { input: 5 },
    });
    expect(after.get('failed')).toMatchObject({ status: 'error', error: 'model went away' });
  });

  it('leaves usage unset when the provider reported no tokens', () => {
    const traces = new TraceRecorder();
    traces.record(event('run-0', 'lifecycle', { phase: 'start', model: 'm' }));
    traces.record(event('run-0', 'lifecycle', { phase: 'end', usage: { input: 0, output: 0 } }));
    expect(traces.get('run-0')!.usage).toBeUndefined();
  });

  it('marks failing tools and failed runs', () => {
    const traces = new TraceRecorder();
    traces.record(event('run-2', 'lifecycle', { phase: 'start', model: 'm' }));
    traces.record(
      event('run-2', 'tool', {
        phase: 'start',
        toolCallId: 't',
        name: 'exec',
        summary: '$ npm test',
        args: {},
      }),
    );
    traces.record(
      event('run-2', 'tool', {
        phase: 'result',
        toolCallId: 't',
        name: 'exec',
        isError: true,
        result: 'ERROR: exit 1',
      }),
    );
    traces.record(event('run-2', 'lifecycle', { phase: 'error', error: 'model went away' }));

    const trace = traces.get('run-2')!;
    expect(trace.status).toBe('error');
    expect(trace.errors).toBe(2);
    expect(trace.error).toBe('model went away');
    expect(trace.events.find((e) => e.kind === 'tool.result')!.isError).toBe(true);
  });

  it('redacts secrets that pass through a tool before storing them', () => {
    const traces = new TraceRecorder({ secrets: () => ['my-gateway-token-123'] });
    traces.record(event('run-3', 'lifecycle', { phase: 'start' }));
    traces.record(
      event('run-3', 'tool', {
        phase: 'start',
        toolCallId: 't',
        name: 'exec',
        summary: '$ echo my-gateway-token-123',
        args: { command: 'echo my-gateway-token-123' },
      }),
    );
    traces.record(
      event('run-3', 'tool', {
        phase: 'result',
        toolCallId: 't',
        name: 'exec',
        result: 'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123',
      }),
    );

    const serialised = JSON.stringify(traces.export({ runId: 'run-3' }));
    expect(serialised).not.toContain('my-gateway-token-123');
    expect(serialised).not.toContain('sk-proj-abcdefghij');
  });

  it('lists runs newest first and filters them', () => {
    const traces = new TraceRecorder();
    traces.record(event('a', 'lifecycle', { phase: 'start' }));
    traces.record(event('a', 'lifecycle', { phase: 'end' }));
    traces.record(event('b', 'lifecycle', { phase: 'start' }));
    traces.record(event('b', 'lifecycle', { phase: 'error', error: 'x' }));

    expect(traces.list().map((r) => r.runId)).toEqual(['b', 'a']);
    expect(traces.list({ status: 'error' }).map((r) => r.runId)).toEqual(['b']);
  });
});

describe('traces from a real agent run', () => {
  it('records the run the runtime actually executed', async () => {
    const { rt } = await makeRuntime([
      { toolCalls: [{ name: 'read', input: { path: 'AGENTS.md' } }] },
      { text: 'Read it.' },
    ]);

    const result = await rt.agent.runAndWait({
      sessionKey: rt.canonical('main'),
      message: 'Read AGENTS.md',
      source: { kind: 'user' },
    });

    const trace = rt.traces.get(result.runId)!;
    expect(trace).toBeDefined();
    expect(trace.status).toBe('ok');
    expect(trace.toolCalls).toBe(1);
    expect(trace.events.some((e) => e.kind === 'tool.start' && e.tool === 'read')).toBe(true);

    // Telemetry saw the same run.
    const summary = rt.telemetry.summary();
    expect(summary.runs).toBe(1);
    expect(summary.toolCalls).toBe(1);
  });
});
