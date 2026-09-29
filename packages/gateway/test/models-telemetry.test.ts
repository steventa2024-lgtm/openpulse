import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectLmStudio, detectOllama, inspectOllamaModel } from '../src/models/detect.js';
import { TelemetryStore } from '../src/telemetry/store.js';
import { tempDir } from './helpers.js';

/** A fetch stand-in that answers the URLs a probe asks for. */
function fakeFetch(routes: Record<string, { status?: number; body: unknown }>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const match = Object.entries(routes).find(([pattern]) => url.includes(pattern));
    if (!match) throw new Error(`ECONNREFUSED ${url}`);
    const [, route] = match;
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('local provider detection', () => {
  it('lists the models Ollama has installed', async () => {
    const probe = await detectOllama({
      fetchFn: fakeFetch({
        '/api/tags': {
          body: {
            models: [
              {
                name: 'qwen3:8b',
                model: 'qwen3:8b',
                size: 5_225_388_164,
                modified_at: '2026-09-14T14:42:54Z',
                details: { family: 'qwen3', parameter_size: '8.2B', quantization_level: 'Q4_K_M' },
              },
            ],
          },
        },
        '/api/version': { body: { version: '0.6.0' } },
      }),
    });

    expect(probe).toMatchObject({ id: 'ollama', running: true, installed: true, version: '0.6.0' });
    expect(probe.models[0]).toMatchObject({
      id: 'qwen3:8b',
      ref: 'ollama/qwen3:8b',
      parameterSize: '8.2B',
      quantisation: 'Q4_K_M',
    });
  });

  it('says plainly when Ollama is not running, and what to do', async () => {
    const probe = await detectOllama({ fetchFn: fakeFetch({}) });

    expect(probe.running).toBe(false);
    expect(probe.models).toEqual([]);
    expect(probe.error).toContain('not running');
    expect(probe.hint).toContain('ollama.com');
  });

  it('notices Ollama running with nothing installed', async () => {
    const probe = await detectOllama({
      fetchFn: fakeFetch({ '/api/tags': { body: { models: [] } } }),
    });

    expect(probe.running).toBe(true);
    expect(probe.hint).toContain('ollama pull');
  });

  it('lists LM Studio models, and explains an empty server', async () => {
    const loaded = await detectLmStudio({
      fetchFn: fakeFetch({
        '/v1/models': { body: { data: [{ id: 'qwen2.5-coder-7b-instruct' }] } },
      }),
    });
    expect(loaded.models[0]).toMatchObject({
      id: 'qwen2.5-coder-7b-instruct',
      ref: 'lmstudio/qwen2.5-coder-7b-instruct',
    });

    const empty = await detectLmStudio({
      fetchFn: fakeFetch({ '/v1/models': { body: { data: [] } } }),
    });
    expect(empty.hint).toContain('Developer tab');

    const down = await detectLmStudio({ fetchFn: fakeFetch({}) });
    expect(down.running).toBe(false);
  });
});

describe('model inspection', () => {
  it('reports the context window and tool support, and warns about a small window', async () => {
    const details = await inspectOllamaModel('qwen3:8b', {
      fetchFn: fakeFetch({
        '/api/show': {
          body: {
            details: { family: 'qwen3' },
            model_info: { 'qwen3.context_length': 40960 },
            capabilities: ['completion', 'tools'],
            parameters: 'temperature 0.6\ntop_p 0.95',
          },
        },
      }),
    });

    expect(details.contextLength).toBe(40960);
    expect(details.supportsTools).toBe(true);
    expect(details.family).toBe('qwen3');
    expect(details.parameters).toMatchObject({ temperature: '0.6' });
    // Nothing set OLLAMA_CONTEXT_LENGTH, which is the usual cause of truncated prompts.
    expect(details.warnings.join(' ')).toContain('OLLAMA_CONTEXT_LENGTH');
  });

  it('warns when a model cannot call tools', async () => {
    const details = await inspectOllamaModel('gemma:2b', {
      fetchFn: fakeFetch({
        '/api/show': {
          body: { details: { family: 'gemma' }, model_info: {}, capabilities: ['completion'] },
        },
      }),
    });

    expect(details.supportsTools).toBe(false);
    expect(details.warnings.join(' ')).toContain('does not advertise tool calling');
  });
});

describe('telemetry', () => {
  async function store(): Promise<TelemetryStore> {
    return new TelemetryStore(path.join(await tempDir(), 'telemetry'), { persist: false });
  }

  const run = (over: Partial<Parameters<TelemetryStore['recordRun']>[0]> = {}) => ({
    ts: Date.now(),
    runId: `run-${Math.random()}`,
    sessionKey: 'agent:main:main',
    model: 'ollama/qwen3:8b',
    provider: 'ollama',
    durationMs: 1000,
    inputTokens: 100,
    outputTokens: 20,
    toolCalls: 1,
    status: 'ok' as const,
    ...over,
  });

  it('summarises only what was measured', async () => {
    const telemetry = await store();
    telemetry.recordRun(run({ durationMs: 500, inputTokens: 10, outputTokens: 5 }));
    telemetry.recordRun(run({ durationMs: 1500, inputTokens: 30, outputTokens: 15, toolCalls: 3 }));
    telemetry.recordRun(run({ status: 'error', error: 'model unavailable', durationMs: 100 }));

    const summary = telemetry.summary();
    expect(summary).toMatchObject({
      runs: 3,
      errors: 1,
      inputTokens: 140,
      outputTokens: 40,
      toolCalls: 5,
    });
    expect(summary.models).toHaveLength(1);
    expect(summary.models[0]).toMatchObject({
      model: 'ollama/qwen3:8b',
      provider: 'ollama',
      runs: 3,
      errors: 1,
    });
    expect(summary.models[0]!.averageDurationMs).toBe(700);
  });

  it('separates models and sessions', async () => {
    const telemetry = await store();
    telemetry.recordRun(run({ model: 'anthropic/claude-opus-5', provider: 'anthropic' }));
    telemetry.recordRun(run({ sessionKey: 'agent:main:telegram:dm:42' }));

    expect(
      telemetry
        .summary()
        .models.map((m) => m.model)
        .sort(),
    ).toEqual(['anthropic/claude-opus-5', 'ollama/qwen3:8b']);
    expect(telemetry.summary({ sessionKey: 'agent:main:telegram:dm:42' }).runs).toBe(1);
    expect(telemetry.list({ model: 'anthropic/claude-opus-5' })).toHaveLength(1);
  });

  it('ranks tools by use', async () => {
    const telemetry = await store();
    for (let i = 0; i < 3; i += 1) {
      telemetry.recordTool({
        ts: Date.now(),
        runId: 'r',
        sessionKey: 's',
        tool: 'read',
        durationMs: 10,
        isError: false,
      });
    }
    telemetry.recordTool({
      ts: Date.now(),
      runId: 'r',
      sessionKey: 's',
      tool: 'exec',
      durationMs: 900,
      isError: true,
    });

    const [first, second] = telemetry.summary().topTools;
    expect(first).toMatchObject({ tool: 'read', calls: 3, errors: 0, averageDurationMs: 10 });
    expect(second).toMatchObject({ tool: 'exec', calls: 1, errors: 1 });
  });

  it('ignores anything older than the window asked for', async () => {
    const telemetry = await store();
    telemetry.recordRun(run({ ts: Date.now() - 48 * 3_600_000 }));
    telemetry.recordRun(run());

    expect(telemetry.summary({ since: Date.now() - 3_600_000 }).runs).toBe(1);
    expect(telemetry.summary().runs).toBe(2);
    expect(telemetry.summary().activity).toHaveLength(24);
  });

  it('reloads history from disk', async () => {
    const dir = path.join(await tempDir(), 'telemetry');
    const first = new TelemetryStore(dir);
    first.recordRun(run({ runId: 'persisted' }));
    await first.flush();

    const second = new TelemetryStore(dir);
    await second.load();
    expect(second.list().map((r) => r.runId)).toContain('persisted');
  });
});
