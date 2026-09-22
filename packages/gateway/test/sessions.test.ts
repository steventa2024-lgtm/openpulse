import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { transcriptToMessages } from '../src/agent/context.js';
import {
  canonicalSessionKey,
  cronSessionKey,
  mainSessionKey,
  parseSessionKey,
  resolveSessionKey,
} from '../src/sessions/keys.js';
import { SessionStore } from '../src/sessions/store.js';
import {
  appendTranscript,
  readTranscript,
  textOf,
  type TranscriptEntry,
} from '../src/sessions/transcript.js';
import { tempDir } from './helpers.js';

describe('session keys', () => {
  const dm = { channel: 'telegram', peerKind: 'dm' as const, peerId: '42' };

  it('routes DMs by dmScope', () => {
    expect(resolveSessionKey(dm, { dmScope: 'main' })).toBe('agent:main:main');
    expect(resolveSessionKey(dm, { dmScope: 'per-peer' })).toBe('agent:main:dm:42');
    expect(resolveSessionKey(dm, { dmScope: 'per-channel-peer' })).toBe(
      'agent:main:telegram:dm:42',
    );
    expect(
      resolveSessionKey({ ...dm, accountId: 'work' }, { dmScope: 'per-account-channel-peer' }),
    ).toBe('agent:main:telegram:work:dm:42');
  });

  it('isolates groups and topics regardless of dmScope', () => {
    expect(
      resolveSessionKey(
        { channel: 'telegram', peerKind: 'group', peerId: '-100123' },
        { dmScope: 'main' },
      ),
    ).toBe('agent:main:telegram:group:-100123');
    expect(
      resolveSessionKey(
        { channel: 'telegram', peerKind: 'group', peerId: '-100123', threadId: '7' },
        { dmScope: 'main' },
      ),
    ).toBe('agent:main:telegram:group:-100123:topic:7');
  });

  it('sanitises ids and canonicalises shorthand keys', () => {
    expect(resolveSessionKey({ ...dm, peerId: 'a/../b c' }, { dmScope: 'per-peer' })).toBe(
      'agent:main:dm:a_.._b_c',
    );
    expect(canonicalSessionKey('main')).toBe('agent:main:main');
    expect(canonicalSessionKey('')).toBe('agent:main:main');
    expect(canonicalSessionKey('telegram:dm:42')).toBe('agent:main:telegram:dm:42');
    expect(canonicalSessionKey('agent:other:main')).toBe('agent:other:main');
    expect(cronSessionKey('ab12')).toBe('agent:main:cron:ab12');
    expect(mainSessionKey()).toBe('agent:main:main');
  });

  it('classifies keys', () => {
    expect(parseSessionKey('agent:main:main').kind).toBe('main');
    expect(parseSessionKey('agent:main:telegram:dm:42').kind).toBe('direct');
    expect(parseSessionKey('agent:main:telegram:group:-1').kind).toBe('group');
    expect(parseSessionKey('agent:main:cron:x').kind).toBe('cron');
  });
});

describe('SessionStore', () => {
  it('creates, patches, resets and deletes sessions', async () => {
    const store = new SessionStore(await tempDir());
    const key = 'agent:main:main';
    const entry = await store.ensure(key, { displayName: 'Main' });
    expect(entry.sessionId).toMatch(/[0-9a-f-]{36}/);
    expect(entry.chatType).toBe('main');
    expect((await store.ensure(key)).sessionId).toBe(entry.sessionId);

    await store.patch(key, {
      thinkingLevel: 'high',
      lastChannel: 'telegram',
      lastTo: '42',
      inputTokens: 100,
      totalTokens: 100,
    });
    expect(await store.get(key)).toMatchObject({
      thinkingLevel: 'high',
      lastChannel: 'telegram',
      inputTokens: 100,
    });

    const reset = await store.reset(key);
    expect(reset.sessionId).not.toBe(entry.sessionId);
    expect(reset.thinkingLevel).toBe('high'); // overrides survive
    expect(reset.lastTo).toBe('42');
    expect(reset.totalTokens).toBe(0); // usage does not

    expect((await store.list()).map((s) => s.key)).toEqual([key]);
    expect(await store.delete(key)).toBe(true);
    expect(await store.get(key)).toBeUndefined();
  });

  it('persists across instances', async () => {
    const dir = await tempDir();
    const a = new SessionStore(dir);
    const entry = await a.ensure('agent:main:main');
    const b = new SessionStore(dir);
    expect((await b.get('agent:main:main'))?.sessionId).toBe(entry.sessionId);
    expect(b.transcriptFile(entry)).toBe(path.join(dir, `${entry.sessionId}.jsonl`));
  });
});

describe('transcripts', () => {
  it('appends a session header then JSONL messages', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 's1.jsonl');
    await appendTranscript(
      file,
      's1',
      {
        role: 'user',
        content: [{ type: 'text', text: 'hi' }],
        timestamp: Date.now(),
        source: 'telegram:42',
      },
      dir,
    );
    await appendTranscript(file, 's1', {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'hello' },
        { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.txt' } },
      ],
      timestamp: Date.now(),
      model: 'm',
    });
    await appendTranscript(file, 's1', {
      role: 'toolResult',
      toolCallId: 'c1',
      toolName: 'read',
      content: [{ type: 'text', text: 'file body' }],
      isError: false,
      timestamp: Date.now(),
    });

    const entries = await readTranscript(file);
    expect(entries.map((e) => e.message.role)).toEqual(['user', 'assistant', 'toolResult']);
    expect(textOf(entries[1]!.message.content)).toBe('hello');
    const raw = await (await import('node:fs/promises')).readFile(file, 'utf8');
    expect(JSON.parse(raw.split('\n')[0]!)).toMatchObject({
      type: 'session',
      version: 1,
      id: 's1',
    });
  });

  it('skips corrupt lines instead of failing', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 's2.jsonl');
    await appendTranscript(file, 's2', {
      role: 'user',
      content: [{ type: 'text', text: 'ok' }],
      timestamp: Date.now(),
    });
    await (await import('node:fs/promises')).appendFile(file, 'not json\n');
    expect(await readTranscript(file)).toHaveLength(1);
  });
});

describe('transcriptToMessages', () => {
  const entry = (message: TranscriptEntry['message']): TranscriptEntry => ({
    type: 'message',
    id: 'x',
    timestamp: '',
    message,
  });

  it('converts roles and keeps tool pairs', () => {
    const messages = transcriptToMessages(
      [
        entry({ role: 'user', content: [{ type: 'text', text: 'read a.txt' }], timestamp: 1 }),
        entry({
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'x' },
            { type: 'text', text: 'sure' },
            { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.txt' } },
          ],
          timestamp: 2,
        }),
        entry({
          role: 'toolResult',
          toolCallId: 'c1',
          toolName: 'read',
          content: [{ type: 'text', text: 'body' }],
          isError: false,
          timestamp: 3,
        }),
        entry({ role: 'assistant', content: [{ type: 'text', text: 'done' }], timestamp: 4 }),
      ],
      100_000,
    );
    expect(messages).toHaveLength(4);
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: [
        { type: 'text', text: 'sure' },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'read' },
      ],
    });
    expect(messages[2]).toMatchObject({
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'c1', output: { type: 'text', value: 'body' } }],
    });
  });

  it('synthesises results for interrupted tool calls', () => {
    const messages = transcriptToMessages(
      [
        entry({ role: 'user', content: [{ type: 'text', text: 'go' }], timestamp: 1 }),
        entry({
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'c9', name: 'exec', arguments: {} }],
          timestamp: 2,
          stopReason: 'aborted',
        }),
      ],
      100_000,
    );
    expect(messages[2]).toMatchObject({
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'c9', output: { type: 'error-text' } }],
    });
  });

  it('trims old turns to the budget and always starts on a user turn', () => {
    const entries: TranscriptEntry[] = [];
    for (let i = 0; i < 10; i++) {
      entries.push(
        entry({
          role: 'user',
          content: [{ type: 'text', text: `q${i} ${'x'.repeat(200)}` }],
          timestamp: i,
        }),
      );
      entries.push(
        entry({ role: 'assistant', content: [{ type: 'text', text: `a${i}` }], timestamp: i }),
      );
    }
    const messages = transcriptToMessages(entries, 1000);
    expect(messages.length).toBeLessThan(20);
    expect(messages[0]!.role).toBe('user');
    expect(messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'a9' }],
    });
  });
});
