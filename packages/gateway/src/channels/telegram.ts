import { timingSafeEqual } from 'node:crypto';
import type { ExecApprovalRequest, ExecDecision } from '../approvals/exec-approvals.js';
import type { TelegramConfig } from '../config/schema.js';
import { chunkText, escapeHtml, markdownToTelegramHtml } from './telegram-format.js';
import type { ChannelContext, ChannelPlugin, ChannelStatus, InboundMessage } from './types.js';

interface TgUser {
  id: number;
  first_name?: string;
  username?: string;
  is_bot?: boolean;
}
interface TgMessage {
  message_id: number;
  message_thread_id?: number;
  chat: { id: number; type: 'private' | 'group' | 'supergroup' | 'channel'; title?: string };
  from?: TgUser;
  text?: string;
  caption?: string;
  entities?: { type: string; offset: number; length: number }[];
  reply_to_message?: { from?: TgUser };
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: { id: string; from: TgUser; data?: string; message?: TgMessage };
}

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly description: string,
    readonly retryAfter?: number,
  ) {
    super(`Telegram ${method} failed (${code}): ${description}`);
  }
}

const APPROVAL_DATA = /^ap:([0-9a-f]{8}):(once|always|deny)$/;
const NATIVE_COMMANDS = [
  { command: 'new', description: 'Start a new session' },
  { command: 'stop', description: 'Stop the current run' },
  { command: 'status', description: 'Session and model status' },
  { command: 'model', description: 'Show or set the model' },
  { command: 'think', description: 'Set thinking level' },
  { command: 'help', description: 'List commands' },
];

export interface TelegramOptions {
  token: string;
  config: () => TelegramConfig;
  fetch?: typeof fetch;
  apiBase?: string;
  pollTimeoutSeconds?: number;
}

/** Telegram Bot API channel: long polling by default, webhook when channels.telegram.webhookUrl is set. */
export class TelegramChannel implements ChannelPlugin {
  readonly id = 'telegram';
  readonly label = 'Telegram';
  private ctx: ChannelContext | undefined;
  private poller: AbortController | undefined;
  private loop: Promise<void> | undefined;
  private offset = 0;
  private bot: TgUser | undefined;
  private readonly fetch: typeof fetch;
  private readonly apiBase: string;
  private readonly approvalMessages = new Map<
    string,
    { chatId: string; messageId: number; text: string }
  >();
  private state: Omit<ChannelStatus, 'id' | 'label'> = {
    configured: true,
    running: false,
    connected: false,
  };

  constructor(private readonly opts: TelegramOptions) {
    this.fetch = opts.fetch ?? fetch;
    this.apiBase = opts.apiBase ?? 'https://api.telegram.org';
  }

  status(): ChannelStatus {
    return {
      id: this.id,
      label: this.label,
      ...this.state,
      ...(this.bot?.username && { accountName: `@${this.bot.username}` }),
    };
  }

  async start(ctx: ChannelContext): Promise<void> {
    this.ctx = ctx;
    this.state = { ...this.state, lastStartAt: Date.now(), running: true };
    try {
      this.bot = await this.call<TgUser>('getMe', {});
      await this.call('setMyCommands', { commands: NATIVE_COMMANDS }).catch(() => undefined);
      const cfg = this.opts.config();
      if (cfg.webhookUrl) {
        await this.call('setWebhook', {
          url: cfg.webhookUrl,
          ...(cfg.webhookSecret && { secret_token: cfg.webhookSecret }),
          allowed_updates: ['message', 'callback_query'],
        });
        this.state.mode = 'webhook';
      } else {
        await this.call('deleteWebhook', { drop_pending_updates: false });
        this.poller = new AbortController();
        this.loop = this.poll(this.poller.signal);
        this.state.mode = 'polling';
      }
      this.state.connected = true;
      delete this.state.lastError;
      ctx.log.info(`telegram @${this.bot.username} connected (${this.state.mode})`);
    } catch (error) {
      this.state = {
        ...this.state,
        running: false,
        connected: false,
        lastError: (error as Error).message,
      };
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.poller?.abort();
    await this.loop?.catch(() => undefined);
    this.state = { ...this.state, running: false, connected: false };
  }

  async probe(): Promise<Record<string, unknown>> {
    const started = Date.now();
    const me = await this.call<TgUser>('getMe', {});
    const hook = await this.call<{ url: string; pending_update_count: number }>(
      'getWebhookInfo',
      {},
    ).catch(() => undefined);
    return {
      ok: true,
      bot: `@${me.username}`,
      elapsedMs: Date.now() - started,
      webhook: hook?.url || null,
      pending: hook?.pending_update_count ?? 0,
    };
  }

  async send(to: string, text: string): Promise<void> {
    const [chatId, thread] = to.split(':topic:');
    for (const chunk of chunkText(text)) {
      try {
        await this.call('sendMessage', {
          chat_id: chatId,
          text: markdownToTelegramHtml(chunk),
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: !this.opts.config().linkPreview },
          ...(thread && { message_thread_id: Number(thread) }),
        });
      } catch (error) {
        if (error instanceof TelegramApiError && error.code === 400) {
          await this.call('sendMessage', {
            chat_id: chatId,
            text: chunk,
            ...(thread && { message_thread_id: Number(thread) }),
          });
        } else throw error;
      }
    }
    this.state.lastOutboundAt = Date.now();
  }

  async typing(to: string): Promise<void> {
    await this.call('sendChatAction', { chat_id: to.split(':topic:')[0], action: 'typing' });
  }

  async approvalPrompt(to: string, a: ExecApprovalRequest): Promise<void> {
    const mins = Math.round((a.expiresAtMs - a.createdAtMs) / 60_000);
    const text = [
      `🛡️ <b>Exec approval required</b> (${escapeHtml(a.request.risk.level)}: ${escapeHtml(a.request.risk.reason)})`,
      `<pre>${escapeHtml(a.request.command.slice(0, 3000))}</pre>`,
      `<i>cwd: ${escapeHtml(a.request.cwd)} · session ${escapeHtml(a.request.sessionKey)} · expires in ${mins} min</i>`,
      `Or reply <code>/approve ${a.id} allow-once|allow-always|deny</code>`,
    ].join('\n');
    const chatId = to.split(':topic:')[0]!;
    const msg = await this.call<TgMessage>('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Allow once', callback_data: `ap:${a.id}:once` },
            { text: '♾️ Always', callback_data: `ap:${a.id}:always` },
            { text: '⛔ Deny', callback_data: `ap:${a.id}:deny` },
          ],
        ],
      },
    });
    this.approvalMessages.set(a.id, { chatId, messageId: msg.message_id, text });
  }

  async approvalResolved(id: string, decision: string, by: string): Promise<void> {
    const shown = this.approvalMessages.get(id);
    if (!shown) return;
    this.approvalMessages.delete(id);
    await this.call('editMessageText', {
      chat_id: shown.chatId,
      message_id: shown.messageId,
      text: `${shown.text}\n\n<b>${escapeHtml(decision)}</b> — ${escapeHtml(by)}`,
      parse_mode: 'HTML',
    }).catch(() => undefined);
  }

  handleWebhook(req: {
    headers: Record<string, string | string[] | undefined>;
    body: unknown;
  }): Promise<{ status: number; body?: unknown }> {
    const secret = this.opts.config().webhookSecret;
    const header = req.headers['x-telegram-bot-api-secret-token'];
    const given = Array.isArray(header) ? header[0] : header;
    if (secret && (!given || !safeEqual(given, secret)))
      return Promise.resolve({ status: 401, body: { ok: false } });
    void this.processUpdate(req.body as TgUpdate);
    return Promise.resolve({ status: 200, body: { ok: true } });
  }

  async processUpdate(update: TgUpdate): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      if (update.callback_query) return await this.onCallback(update.callback_query);
      const m = update.message;
      const text = m?.text ?? m?.caption;
      if (!m?.from || !text || m.from.is_bot) return;
      this.state.lastInboundAt = Date.now();
      const isGroup = m.chat.type === 'group' || m.chat.type === 'supergroup';
      const uname = this.bot?.username?.toLowerCase();
      const mentioned =
        (uname !== undefined &&
          (m.entities ?? []).some(
            (e) =>
              e.type === 'mention' &&
              text.slice(e.offset, e.offset + e.length).toLowerCase() === `@${uname}`,
          )) ||
        (m.reply_to_message?.from?.id !== undefined && m.reply_to_message.from.id === this.bot?.id);
      const inbound: InboundMessage = {
        channel: this.id,
        chatId: String(m.chat.id),
        chatType: isGroup ? 'group' : 'dm',
        senderId: String(m.from.id),
        ...(m.from.first_name !== undefined && { senderName: m.from.first_name }),
        text: uname ? text.replace(new RegExp(`@${uname}\\b`, 'ig'), '').trim() || text : text,
        mentioned,
        messageId: String(m.message_id),
        ...(isGroup &&
          m.message_thread_id !== undefined && { threadId: String(m.message_thread_id) }),
      };
      await ctx.onInbound(inbound);
    } catch (error) {
      ctx.log.error(`telegram update ${update.update_id} failed: ${(error as Error).message}`);
    }
  }

  private async onCallback(q: NonNullable<TgUpdate['callback_query']>): Promise<void> {
    const ctx = this.ctx!;
    const m = APPROVAL_DATA.exec(q.data ?? '');
    if (!m) {
      await this.call('answerCallbackQuery', { callback_query_id: q.id });
      return;
    }
    const allowed = await ctx.pairing.isAllowed(
      this.id,
      String(q.from.id),
      this.opts.config().allowFrom,
    );
    if (!allowed) {
      await this.call('answerCallbackQuery', { callback_query_id: q.id, text: 'Not authorized.' });
      return;
    }
    const decision: ExecDecision =
      m[2] === 'once' ? 'allow-once' : m[2] === 'always' ? 'allow-always' : 'deny';
    const ok = ctx.approvals.resolve(m[1]!, decision, `telegram:${q.from.username ?? q.from.id}`);
    await this.call('answerCallbackQuery', {
      callback_query_id: q.id,
      text: ok ? decision : 'Already decided.',
    });
  }

  private async poll(signal: AbortSignal): Promise<void> {
    const timeout = this.opts.pollTimeoutSeconds ?? 30;
    while (!signal.aborted) {
      try {
        const updates = await this.call<TgUpdate[]>(
          'getUpdates',
          { offset: this.offset, timeout, allowed_updates: ['message', 'callback_query'] },
          signal,
        );
        for (const u of updates) {
          this.offset = u.update_id + 1;
          void this.processUpdate(u);
        }
        this.state.connected = true;
      } catch (error) {
        if (signal.aborted) return;
        this.state.connected = false;
        this.state.lastError = (error as Error).message;
        const wait =
          error instanceof TelegramApiError && error.retryAfter ? error.retryAfter * 1000 : 5000;
        this.ctx?.log.warn(`telegram polling error: ${(error as Error).message}`);
        await new Promise((r) => {
          const t = setTimeout(r, wait);
          signal.addEventListener('abort', () => (clearTimeout(t), r(undefined)), { once: true });
        });
      }
    }
  }

  private async call<T = unknown>(
    method: string,
    params: object,
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await this.fetch(`${this.apiBase}/bot${this.opts.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      ...(signal && { signal }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: T;
      error_code?: number;
      description?: string;
      parameters?: { retry_after?: number };
    };
    if (!body.ok)
      throw new TelegramApiError(
        method,
        body.error_code ?? res.status,
        body.description ?? res.statusText,
        body.parameters?.retry_after,
      );
    return body.result as T;
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
