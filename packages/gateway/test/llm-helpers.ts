import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { MockLanguageModelV4 } from 'ai/test';
import type { ModelFactory } from '../src/agent/models.js';

export interface ScriptedStep {
  text?: string;
  thinking?: string;
  toolCalls?: { name: string; input: unknown }[];
  /** Fail this model call. */
  error?: string;
}

const usage = {
  inputTokens: { total: 120, noCache: 120, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 24, text: 24, reasoning: 0 },
};

/**
 * A fake model that streams a fixed sequence of responses (one per model call) and records every
 * prompt. Steps with tool calls finish with `tool-calls`, so the SDK runs tools and calls again.
 */
export function scriptedModel(steps: ScriptedStep[]) {
  let call = 0;
  const calls: LanguageModelV4CallOptions[] = [];

  const model = new MockLanguageModelV4({
    provider: 'scripted',
    modelId: 'scripted-model',
    doStream: (options) => {
      calls.push(options);
      const step = steps[call++] ?? { text: '(script exhausted)' };
      if (step.error) return Promise.reject(new Error(step.error));
      const parts: LanguageModelV4StreamPart[] = [{ type: 'stream-start', warnings: [] }];
      if (step.thinking) {
        parts.push(
          { type: 'reasoning-start', id: 'r1' },
          { type: 'reasoning-delta', id: 'r1', delta: step.thinking },
          { type: 'reasoning-end', id: 'r1' },
        );
      }
      if (step.text) {
        parts.push({ type: 'text-start', id: 't1' });
        for (const piece of chunks(step.text))
          parts.push({ type: 'text-delta', id: 't1', delta: piece });
        parts.push({ type: 'text-end', id: 't1' });
      }
      (step.toolCalls ?? []).forEach((tc, i) => {
        parts.push({
          type: 'tool-call',
          toolCallId: `call_${call}_${i}`,
          toolName: tc.name,
          input: JSON.stringify(tc.input),
        });
      });
      parts.push({
        type: 'finish',
        finishReason: { unified: step.toolCalls?.length ? 'tool-calls' : 'stop', raw: 'stop' },
        usage,
      });
      return Promise.resolve({
        stream: new ReadableStream({
          start(controller) {
            for (const p of parts) controller.enqueue(p);
            controller.close();
          },
        }),
      });
    },
  });

  const factory: ModelFactory = () => model;
  return {
    model,
    factory,
    calls,
    /** Number of model calls so far. */
    get count() {
      return calls.length;
    },
    system: (n = 0) => {
      const msg = calls[n]?.prompt.find((m) => m.role === 'system');
      return msg && typeof msg.content === 'string' ? msg.content : '';
    },
    /** Flattened non-system messages of the Nth call, e.g. "user: hi". */
    transcript: (n = 0) =>
      (calls[n]?.prompt ?? [])
        .filter((m) => m.role !== 'system')
        .map((m) => {
          const parts = Array.isArray(m.content) ? m.content : [];
          const text = parts
            .map((p) =>
              p.type === 'text'
                ? p.text
                : p.type === 'tool-call'
                  ? `[call ${p.toolName}]`
                  : p.type === 'tool-result'
                    ? `[result ${JSON.stringify(p.output)}]`
                    : `[${p.type}]`,
            )
            .join(' ');
          return `${m.role}: ${typeof m.content === 'string' ? m.content : text}`;
        }),
    toolNames: (n = 0) => (calls[n]?.tools ?? []).map((t) => t.name),
  };
}

function chunks(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += 12) out.push(text.slice(i, i + 12));
  return out.length ? out : [text];
}
