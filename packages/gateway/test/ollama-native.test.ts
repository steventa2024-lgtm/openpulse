import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OLLAMA_DEFAULT_CONTEXT,
  contextWindowFor,
  createModel,
  ollamaApiBase,
  parseModelRef,
} from '../src/agent/models.js';
import { historyBudgetChars } from '../src/agent/runner.js';
import { makeRuntime } from './helpers.js';

interface ChatRequest {
  model: string;
  messages: { role: string; content: string }[];
  options?: { num_ctx?: number };
  tools?: { function: { name: string } }[];
}

/** A stand-in for Ollama's /api/chat that streams NDJSON the way Ollama does. */
async function fakeOllama(reply: (req: ChatRequest, n: number) => Record<string, unknown>[]) {
  const requests: { path: string; body: ChatRequest }[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as ChatRequest;
      requests.push({ path: req.url ?? '', body });
      if (req.url !== '/api/chat') {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      for (const line of reply(body, requests.length)) res.write(`${JSON.stringify(line)}\n`);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

const chunk = (content: string, extra: Record<string, unknown> = {}) => ({
  model: 'qwen3:8b',
  created_at: new Date().toISOString(),
  message: { role: 'assistant', content, ...extra },
  done: false,
});
const done = (promptTokens: number, outputTokens: number) => ({
  model: 'qwen3:8b',
  created_at: new Date().toISOString(),
  message: { role: 'assistant', content: '' },
  done: true,
  done_reason: 'stop',
  prompt_eval_count: promptTokens,
  eval_count: outputTokens,
});

describe('Ollama native API', () => {
  it('normalises the base URL people configure', () => {
    expect(ollamaApiBase('http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434/api');
    expect(ollamaApiBase('http://127.0.0.1:11434/')).toBe('http://127.0.0.1:11434/api');
    expect(ollamaApiBase('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434/api');
    expect(ollamaApiBase('http://gpu-box:11434/api/')).toBe('http://gpu-box:11434/api');
  });

  it('asks Ollama for a real context window, with history and tools, and reads usage back', async () => {
    const ollama = await fakeOllama(() => [chunk('Hello '), chunk('from Ollama'), done(5120, 4)]);
    const { rt } = await makeRuntime([], {
      config: {
        agents: { defaults: { heartbeat: { every: '0m' }, model: { primary: 'ollama/qwen3:8b' } } },
        models: { providers: { ollama: { baseUrl: `${ollama.url}/v1` } } },
      },
      runtime: { modelFactory: createModel },
    });

    const result = await rt.agent.runAndWait({
      sessionKey: 'agent:main:main',
      message: 'hi',
      source: { kind: 'user' },
    });

    expect(result.error).toBeUndefined();
    expect(result.text).toBe('Hello from Ollama');
    expect(result.usage).toMatchObject({ input: 5120, output: 4 });
    const sent = ollama.requests.find((r) => r.path === '/api/chat')!.body;
    expect(sent.model).toBe('qwen3:8b');
    expect(sent.options?.num_ctx).toBe(OLLAMA_DEFAULT_CONTEXT);
    expect(sent.messages[0]?.role).toBe('system');
    expect(sent.messages.at(-1)).toMatchObject({ role: 'user', content: 'hi' });
    expect(sent.tools?.map((t) => t.function.name)).toEqual(
      expect.arrayContaining(['read', 'propose_change']),
    );
  });

  it('runs tool calls that come back from Ollama', async () => {
    const ollama = await fakeOllama((_req, n) =>
      n === 1
        ? [
            chunk('', {
              tool_calls: [{ function: { name: 'session_status', arguments: {} } }],
            }),
            done(4000, 10),
          ]
        : [chunk('Done.'), done(4200, 2)],
    );
    const { rt } = await makeRuntime([], {
      config: {
        agents: { defaults: { heartbeat: { every: '0m' }, model: { primary: 'ollama/qwen3:8b' } } },
        models: { providers: { ollama: { baseUrl: ollama.url } } },
      },
      runtime: { modelFactory: createModel },
    });
    const result = await rt.agent.runAndWait({
      sessionKey: 'agent:main:main',
      message: 'status?',
      source: { kind: 'user' },
    });
    expect(result.error).toBeUndefined();
    expect(result.toolCalls).toBe(1);
    expect(result.text).toBe('Done.');
    const second = ollama.requests.filter((r) => r.path === '/api/chat')[1]!.body;
    expect(second.messages.some((m) => m.role === 'tool')).toBe(true);
  });

  it('uses a configured context size', async () => {
    const config = {
      models: { providers: { ollama: { contextTokens: 32_768 } } },
    } as unknown as Parameters<typeof contextWindowFor>[1];
    expect(contextWindowFor(parseModelRef('ollama/qwen3:8b'), config)).toBe(32_768);
    const plain = { models: { providers: {} } } as unknown as Parameters<
      typeof contextWindowFor
    >[1];
    expect(contextWindowFor(parseModelRef('ollama/qwen3:8b'), plain)).toBe(OLLAMA_DEFAULT_CONTEXT);
    expect(contextWindowFor(parseModelRef('anthropic/claude-opus-5'), plain)).toBeUndefined();
  });
});

describe('history budget', () => {
  it('fits history beside the system prompt in a small window', () => {
    // 16k window, 12k characters of system prompt (~4k tokens), 4k reserved → ~8k tokens left.
    expect(historyBudgetChars(200_000, 16_384, 12_000)).toBe((16_384 - 4_000 - 4_096) * 3);
  });

  it('never goes negative and keeps the configured cap for big windows', () => {
    expect(historyBudgetChars(200_000, 4_096, 12_000)).toBe(0);
    expect(historyBudgetChars(1_000, 1_000_000, 100)).toBe(3_000);
    expect(historyBudgetChars(200_000, undefined, 12_000)).toBe(600_000);
  });
});
