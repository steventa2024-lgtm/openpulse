import type { ModelMessage } from 'ai';
import type { TranscriptEntry } from '../sessions/transcript.js';
import { textOf } from '../sessions/transcript.js';

/**
 * Convert a transcript into model messages, keeping tool call/result pairs intact and trimming
 * the oldest turns to fit `maxChars` (≈ 4 chars/token). The context always starts on a user turn.
 */
export function transcriptToMessages(entries: TranscriptEntry[], maxChars: number): ModelMessage[] {
  // Group into turns that start at each user message so trimming never splits tool pairs.
  const turns: TranscriptEntry[][] = [];
  for (const e of entries) {
    if (e.message.role === 'user' || turns.length === 0) turns.push([e]);
    else turns[turns.length - 1]!.push(e);
  }

  const kept: TranscriptEntry[][] = [];
  let size = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turnSize = turns[i]!.reduce((n, e) => n + JSON.stringify(e.message.content).length, 0);
    if (kept.length > 0 && size + turnSize > maxChars) break;
    kept.unshift(turns[i]!);
    size += turnSize;
  }

  const out: ModelMessage[] = [];
  for (const e of kept.flat()) {
    const m = e.message;
    if (m.role === 'user') {
      const text = textOf(m.content);
      if (text) out.push({ role: 'user', content: text });
    } else if (m.role === 'assistant') {
      if (m.injected) {
        const text = textOf(m.content);
        if (text) out.push({ role: 'assistant', content: text });
        continue;
      }
      const parts: (
        | { type: 'text'; text: string }
        | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
      )[] = [];
      for (const p of m.content) {
        if (p.type === 'text' && p.text.trim()) parts.push({ type: 'text', text: p.text });
        if (p.type === 'toolCall')
          parts.push({
            type: 'tool-call',
            toolCallId: p.id,
            toolName: p.name,
            input: p.arguments ?? {},
          });
      }
      if (parts.length > 0) out.push({ role: 'assistant', content: parts });
    } else {
      out.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: m.toolCallId,
            toolName: m.toolName,
            output: m.isError
              ? { type: 'error-text', value: textOf(m.content) }
              : { type: 'text', value: textOf(m.content) },
          },
        ],
      });
    }
  }
  return repairToolPairs(dropLeadingNonUser(out));
}

function dropLeadingNonUser(messages: ModelMessage[]): ModelMessage[] {
  const i = messages.findIndex((m) => m.role === 'user');
  return i < 0 ? [] : messages.slice(i);
}

/** Every tool call needs a result (and vice versa) or providers reject the request. */
function repairToolPairs(messages: ModelMessage[]): ModelMessage[] {
  const results = new Set<string>();
  const calls = new Set<string>();
  for (const m of messages) {
    if (m.role === 'tool')
      for (const p of m.content) if (p.type === 'tool-result') results.add(p.toolCallId);
    if (m.role === 'assistant' && Array.isArray(m.content))
      for (const p of m.content) if (p.type === 'tool-call') calls.add(p.toolCallId);
  }
  const out: ModelMessage[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      const content = m.content.filter((p) => p.type !== 'tool-result' || calls.has(p.toolCallId));
      if (content.length > 0) out.push({ ...m, content });
      continue;
    }
    out.push(m);
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const missing = m.content.filter((p) => p.type === 'tool-call' && !results.has(p.toolCallId));
      if (missing.length > 0) {
        out.push({
          role: 'tool',
          content: missing.map((p) => ({
            type: 'tool-result' as const,
            toolCallId: (p as { toolCallId: string }).toolCallId,
            toolName: (p as { toolName: string }).toolName,
            output: {
              type: 'error-text' as const,
              value: 'Tool call was interrupted before it returned.',
            },
          })),
        });
      }
    }
  }
  return out;
}
