import { describe, expect, it, vi } from 'vitest';
import { chunkText, markdownToTelegramHtml } from '../src/channels/telegram-format.js';
import { TelegramChannel } from '../src/channels/telegram.js';
import { makeRuntime } from './helpers.js';

/** Minimal in-memory Telegram Bot API. */
function fakeTelegram() {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const queue: unknown[] = [];
  let messageId = 100;
  let updateId = 1;

  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const method = String(url).split('/').pop()!;
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
      string,
      unknown
    >;
    calls.push({ method, body });
    const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }));
    switch (method) {
      case 'getMe':
        return ok({ id: 1, is_bot: true, username: 'openpulse_test_bot', first_name: 'OpenPulse' });
      case 'getUpdates': {
        for (let i = 0; i < 30 && queue.length === 0 && !init?.signal?.aborted; i++)
          await new Promise((r) => setTimeout(r, 10));
        if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
        return ok(queue.splice(0));
      }
      case 'sendMessage':
        return ok({ message_id: ++messageId, chat: { id: body.chat_id, type: 'private' } });
      default:
        return ok(true);
    }
  }) as typeof fetch;

  return {
    fetch: fetchImpl,
    calls,
    queue,
    sent: () => calls.filter((c) => c.method === 'sendMessage'),
    dm: (fromId: number, text: string) => ({
      update_id: updateId++,
      message: {
        message_id: updateId,
        chat: { id: fromId, type: 'private' },
        from: { id: fromId, first_name: 'Steve' },
        text,
      },
    }),
    group: (chatId: number, fromId: number, text: string, mention = false) => ({
      update_id: updateId++,
      message: {
        message_id: updateId,
        chat: { id: chatId, type: 'supergroup', title: 'Team' },
        from: { id: fromId, first_name: 'Steve' },
        text: mention ? `@openpulse_test_bot ${text}` : text,
        ...(mention && {
          entities: [{ type: 'mention', offset: 0, length: '@openpulse_test_bot'.length }],
        }),
      },
    }),
    callback: (fromId: number, data: string) => ({
      update_id: updateId++,
      callback_query: { id: 'cb1', from: { id: fromId, username: 'steve' }, data },
    }),
  };
}

async function telegramRuntime(
  steps: Parameters<typeof makeRuntime>[0],
  telegram: Record<string, unknown> = {},
) {
  const tg = fakeTelegram();
  const t = await makeRuntime(steps, {
    config: {
      gateway: { auth: { mode: 'token', token: 'test-token' } },
      agents: { defaults: { heartbeat: { every: '0m' } } },
      channels: { telegram: { enabled: true, botToken: '123:abc', ...telegram } },
    },
    runtime: { telegramFetch: tg.fetch },
  });
  await t.rt.channels.sync();
  return { ...t, tg };
}

describe('telegram channel', () => {
  it('pairs unknown senders with a code, then lets them through once approved', async () => {
    const { rt, tg, script } = await telegramRuntime([{ text: 'Hello **Steve**!' }]);
    tg.queue.push(tg.dm(42, 'hi there'));

    await vi.waitFor(() => expect(tg.sent()).toHaveLength(1), { timeout: 8000 });
    const pairingText = String(tg.sent()[0]!.body.text);
    expect(pairingText).toMatch(/access not configured/);
    expect(pairingText).toMatch(/Your Telegram user id: 42/);
    const code = /Pairing code: ([A-Z0-9]{8})/.exec(pairingText)![1]!;
    expect(script.count).toBe(0); // the model never saw the message

    expect(await rt.pairing.listPending('telegram')).toHaveLength(1);
    expect(await rt.pairing.approve('telegram', code)).toMatchObject({ userId: '42' });
    expect(await rt.pairing.isAllowed('telegram', '42')).toBe(true);

    tg.queue.push(tg.dm(42, 'hi again'));
    await vi.waitFor(
      () => expect(tg.sent().some((c) => c.body.text === 'Hello <b>Steve</b>!')).toBe(true),
      { timeout: 8000 },
    );
    expect(await rt.sessions.get('agent:main:main')).toMatchObject({
      lastChannel: 'telegram',
      lastTo: '42',
    });
  });

  it('honours dmPolicy allowlist and ignores strangers', async () => {
    const { tg, script } = await telegramRuntime([{ text: 'hi' }], {
      dmPolicy: 'allowlist',
      allowFrom: ['42'],
    });
    tg.queue.push(tg.dm(99, 'let me in'));
    tg.queue.push(tg.dm(42, 'hello'));
    await vi.waitFor(() => expect(script.count).toBe(1), { timeout: 8000 });
    expect(tg.sent().every((c) => c.body.chat_id !== 99)).toBe(true);
    expect(script.transcript(0)[0]).toBe('user: hello');
  });

  it('requires a mention in groups by default', async () => {
    const { tg, script } = await telegramRuntime([{ text: 'you called?' }], {
      dmPolicy: 'open',
      allowFrom: ['*'],
      groupPolicy: 'open',
    });
    tg.queue.push(tg.group(-100, 42, 'chatting among ourselves'));
    tg.queue.push(tg.group(-100, 42, 'what do you think?', true));
    await vi.waitFor(() => expect(script.count).toBe(1), { timeout: 8000 });
    expect(script.transcript(0)[0]).toBe('user: what do you think?'); // mention stripped
    await vi.waitFor(() => expect(tg.sent()).toHaveLength(1), { timeout: 8000 });
    expect(tg.sent()[0]!.body.chat_id).toBe('-100');
  });

  it('sends exec approval prompts with inline buttons and resolves them from a callback', async () => {
    const { rt, tg } = await telegramRuntime([], { dmPolicy: 'open', allowFrom: ['*'] });
    await rt.sessions.ensure('agent:main:main');
    await rt.sessions.patch('agent:main:main', { lastChannel: 'telegram', lastTo: '42' });

    const pending = rt.approvals.request({
      command: 'rm -rf build',
      cwd: '/w',
      agentId: 'main',
      sessionKey: 'agent:main:main',
      risk: { level: 'high', reason: 'deletes files' },
    });
    await vi.waitFor(
      () =>
        expect(tg.sent().some((c) => String(c.body.text).includes('Exec approval required'))).toBe(
          true,
        ),
      { timeout: 8000 },
    );
    const prompt = tg.sent().find((c) => String(c.body.text).includes('Exec approval required'))!;
    const keyboard = (
      prompt.body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }
    ).inline_keyboard[0]!;
    expect(keyboard.map((b) => b.text)).toEqual(['✅ Allow once', '♾️ Always', '⛔ Deny']);

    tg.queue.push(tg.callback(42, keyboard[0]!.callback_data));
    expect(await pending).toMatchObject({ decision: 'allow-once', resolvedBy: 'telegram:steve' });
    await vi.waitFor(() => expect(tg.calls.some((c) => c.method === 'editMessageText')).toBe(true));
  });

  it('reports channel status and verifies webhook secrets', async () => {
    const { rt, tg } = await telegramRuntime([{ text: 'from webhook' }], {
      dmPolicy: 'open',
      allowFrom: ['*'],
      webhookUrl: 'https://tunnel.example.com/webhooks/telegram',
      webhookSecret: 's3cret',
    });
    const status = rt.channels.status()[0]!;
    expect(status).toMatchObject({
      id: 'telegram',
      running: true,
      connected: true,
      mode: 'webhook',
      accountName: '@openpulse_test_bot',
    });
    expect(tg.calls.find((c) => c.method === 'setWebhook')?.body).toMatchObject({
      url: 'https://tunnel.example.com/webhooks/telegram',
      secret_token: 's3cret',
    });

    const plugin = rt.channels.get('telegram')!;
    expect(await plugin.handleWebhook!({ headers: {}, body: tg.dm(42, 'hi') })).toMatchObject({
      status: 401,
    });
    expect(
      await plugin.handleWebhook!({
        headers: { 'x-telegram-bot-api-secret-token': 's3cret' },
        body: tg.dm(42, 'hi'),
      }),
    ).toMatchObject({ status: 200 });
    await vi.waitFor(
      () => expect(tg.sent().some((c) => c.body.text === 'from webhook')).toBe(true),
      { timeout: 8000 },
    );
  });

  it('stops and restarts when the token changes', async () => {
    const { rt, tg } = await telegramRuntime([]);
    expect(tg.calls.filter((c) => c.method === 'getMe')).toHaveLength(1);
    await rt.config.patch({ channels: { telegram: { botToken: '999:zzz' } } });
    await rt.channels.sync();
    expect(tg.calls.filter((c) => c.method === 'getMe')).toHaveLength(2);

    await rt.config.patch({ channels: { telegram: { enabled: false } } });
    await rt.channels.sync();
    expect(rt.channels.running()).toEqual([]);
    expect(rt.channels.status()[0]).toMatchObject({
      id: 'telegram',
      running: false,
      lastError: 'disabled',
    });
  });

  it('surfaces a start failure in status', async () => {
    const t = await makeRuntime([], {
      config: { channels: { telegram: { enabled: true, botToken: 'bad' } } },
      runtime: {
        telegramFetch: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }),
            ),
          ),
      },
    });
    await t.rt.channels.sync();
    expect(t.rt.channels.status()[0]).toMatchObject({
      running: false,
      lastError: expect.stringContaining('401'),
    });
  });
});

describe('telegram formatting', () => {
  it('converts Markdown to Telegram HTML', () => {
    const md = [
      '# Title',
      '**bold** and *italic* and `a<b>`',
      '- item <two> & three',
      '[docs](https://example.com/a?b=1&c=2)',
      '```js',
      'if (a < b) {}',
      '```',
    ].join('\n');
    expect(markdownToTelegramHtml(md)).toBe(
      [
        '<b>Title</b>',
        '<b>bold</b> and <i>italic</i> and <code>a&lt;b&gt;</code>',
        '• item &lt;two&gt; &amp; three',
        '<a href="https://example.com/a?b=1&amp;c=2">docs</a>',
        '<pre>if (a &lt; b) {}</pre>',
      ].join('\n'),
    );
    expect(markdownToTelegramHtml('snake_case and 2*3*4')).toBe('snake_case and 2*3*4');
  });

  it('chunks long messages under the Telegram limit', () => {
    const para = 'word '.repeat(300).trim();
    const chunks = chunkText(`${para}\n\n${para}\n\n${para}`, 2000);
    expect(chunks.every((c) => c.length <= 2000)).toBe(true);
    expect(chunks).toHaveLength(3);
    expect(chunkText('short')).toEqual(['short']);
  });
});

describe('TelegramChannel unit', () => {
  it('reports configured/running state before start', () => {
    const plugin = new TelegramChannel({
      token: 't',
      config: () =>
        ({
          enabled: true,
          dmPolicy: 'pairing',
          allowFrom: [],
          groupPolicy: 'allowlist',
          linkPreview: true,
        }) as never,
    });
    expect(plugin.status()).toMatchObject({
      id: 'telegram',
      label: 'Telegram',
      running: false,
      connected: false,
    });
  });
});
