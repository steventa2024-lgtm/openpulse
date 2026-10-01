import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/agent/runner.js';
import type { ModelFactory } from '../src/agent/models.js';
import { makeRuntime } from './helpers.js';
import { scriptedModel } from './llm-helpers.js';

const MAIN = 'agent:main:main';

/** Primary ollama/down fails to connect; lmstudio/up answers. */
function models(options: { primaryThrows?: boolean } = {}) {
  const down = scriptedModel([{ error: 'connect ECONNREFUSED 127.0.0.1:11434' }]);
  const up = scriptedModel([{ text: 'answered by the fallback' }]);
  const factory: ModelFactory = (ref) => {
    if (ref.model === 'down') {
      if (options.primaryThrows) throw new Error('No API key for "down".');
      return down.model;
    }
    return up.model;
  };
  return { down, up, factory };
}

const config = {
  agents: {
    defaults: {
      heartbeat: { every: '0m' },
      model: { primary: 'ollama/down', fallbacks: ['lmstudio/up'] },
    },
  },
};

describe('model fallbacks', () => {
  it('moves to the next fallback when the primary fails before answering', async () => {
    const m = models();
    const { rt } = await makeRuntime([], { config, runtime: { modelFactory: m.factory } });
    const events: AgentEvent[] = [];
    rt.agent.on('agent', (e: AgentEvent) => events.push(e));
    const result = await rt.agent.runAndWait({
      sessionKey: MAIN,
      message: 'hi',
      source: { kind: 'user' },
    });

    expect(result.error).toBeUndefined();
    expect(result.text).toBe('answered by the fallback');
    expect(result.model).toBe('lmstudio/up');
    expect(m.down.count).toBeGreaterThan(0);
    expect(m.up.count).toBe(1);

    const fallback = events.find((e) => e.stream === 'lifecycle' && e.data.phase === 'fallback');
    expect(fallback?.data).toMatchObject({ from: 'ollama/down', to: 'lmstudio/up' });
    expect(String(fallback?.data.error)).toMatch(/ECONNREFUSED/);

    const trace = rt.traces.get(result.runId)!;
    expect(trace.model).toBe('lmstudio/up');
    expect(trace.events.some((e) => e.kind === 'model.fallback')).toBe(true);
  });

  it('also covers a primary that cannot be created at all', async () => {
    const m = models({ primaryThrows: true });
    const { rt } = await makeRuntime([], { config, runtime: { modelFactory: m.factory } });
    const result = await rt.agent.runAndWait({
      sessionKey: MAIN,
      message: 'hi',
      source: { kind: 'user' },
    });
    expect(result.text).toBe('answered by the fallback');
    expect(result.model).toBe('lmstudio/up');
  });

  it('reports the last error when every model fails', async () => {
    const down = scriptedModel([{ error: 'primary down' }]);
    const alsoDown = scriptedModel([{ error: 'fallback down too' }]);
    const factory: ModelFactory = (ref) => (ref.model === 'down' ? down.model : alsoDown.model);
    const { rt } = await makeRuntime([], { config, runtime: { modelFactory: factory } });
    const result = await rt.agent.runAndWait({
      sessionKey: MAIN,
      message: 'hi',
      source: { kind: 'user' },
    });
    expect(result.error).toMatch(/fallback down too/);
  });

  it('does not fall back for a model that was asked for explicitly', async () => {
    const m = models();
    const { rt } = await makeRuntime([], { config, runtime: { modelFactory: m.factory } });
    const result = await rt.agent.runAndWait({
      sessionKey: MAIN,
      message: 'hi',
      model: 'ollama/down',
      source: { kind: 'user' },
    });
    expect(result.error).toMatch(/ECONNREFUSED/);
    expect(m.up.count).toBe(0);
  });
});
