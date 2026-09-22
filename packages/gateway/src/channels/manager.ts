import type { AgentService } from '../agent/agent-service.js';
import type {
  ExecApprovalRequest,
  ExecApprovalResolved,
  ExecApprovals,
} from '../approvals/exec-approvals.js';
import type { OpenPulseConfig } from '../config/schema.js';
import type { Logger } from '../infra/logger.js';
import { resolveSessionKey } from '../sessions/keys.js';
import type { SessionStore } from '../sessions/store.js';
import type { PairingStore } from './pairing-store.js';
import { TelegramChannel } from './telegram.js';
import type { ChannelContext, ChannelPlugin, ChannelStatus, InboundMessage } from './types.js';

export interface ChannelManagerDeps {
  config: () => OpenPulseConfig;
  agent: AgentService;
  sessions: SessionStore;
  pairing: PairingStore;
  approvals: ExecApprovals;
  log: Logger;
  telegramFetch?: typeof fetch;
  telegramApiBase?: string;
}

/**
 * Owns channel plugins: starts them from config, enforces DM/group access policy, routes inbound
 * messages to sessions, keeps typing indicators alive and delivers exec approval prompts.
 */
export class ChannelManager {
  private readonly plugins = new Map<string, ChannelPlugin>();
  private readonly errors = new Map<string, string>();
  private telegramSig = '';

  constructor(private readonly deps: ChannelManagerDeps) {
    deps.approvals.on('requested', (a) => void this.promptApproval(a));
    deps.approvals.on('resolved', (r) => void this.approvalDone(r));
  }

  get(id: string): ChannelPlugin | undefined {
    return this.plugins.get(id);
  }

  running(): string[] {
    return [...this.plugins.values()].filter((p) => p.status().running).map((p) => p.id);
  }

  /** Register an extra plugin (tests, future channels). */
  async add(plugin: ChannelPlugin, start = true): Promise<void> {
    await this.remove(plugin.id);
    this.plugins.set(plugin.id, plugin);
    if (start) await this.startPlugin(plugin);
  }

  async remove(id: string): Promise<void> {
    const p = this.plugins.get(id);
    if (!p) return;
    this.plugins.delete(id);
    await p.stop().catch(() => undefined);
  }

  /** (Re)start channels to match config. Safe to call on every config change. */
  async sync(): Promise<void> {
    const tg = this.deps.config().channels.telegram;
    const token = tg?.botToken ?? process.env.TELEGRAM_BOT_TOKEN;
    const sig =
      tg && tg.enabled && token ? JSON.stringify([token, tg.webhookUrl, tg.webhookSecret]) : '';
    if (sig === this.telegramSig) return;
    this.telegramSig = sig;
    await this.remove('telegram');
    this.errors.delete('telegram');
    if (!sig) return;
    const plugin = new TelegramChannel({
      token: token!,
      config: () => this.deps.config().channels.telegram!,
      ...(this.deps.telegramFetch && { fetch: this.deps.telegramFetch }),
      ...(this.deps.telegramApiBase && { apiBase: this.deps.telegramApiBase }),
    });
    this.plugins.set('telegram', plugin);
    await this.startPlugin(plugin);
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.plugins.keys()]) await this.remove(id);
    this.telegramSig = '';
  }

  status(): ChannelStatus[] {
    const out = [...this.plugins.values()].map((p) => {
      const s = p.status();
      const err = this.errors.get(p.id);
      return err && !s.lastError ? { ...s, lastError: err } : s;
    });
    const tg = this.deps.config().channels.telegram;
    if (!this.plugins.has('telegram')) {
      out.push({
        id: 'telegram',
        label: 'Telegram',
        configured: Boolean(tg?.botToken ?? process.env.TELEGRAM_BOT_TOKEN),
        running: false,
        connected: false,
        ...(tg && !tg.enabled && { lastError: 'disabled' }),
      });
    }
    return out;
  }

  async send(channel: string, to: string, text: string): Promise<void> {
    const p = this.plugins.get(channel);
    if (!p) throw new Error(`Channel "${channel}" is not running`);
    await p.send(to, text);
  }

  private async startPlugin(plugin: ChannelPlugin): Promise<void> {
    try {
      await plugin.start(this.context());
      this.errors.delete(plugin.id);
    } catch (error) {
      this.errors.set(plugin.id, (error as Error).message);
      this.deps.log.error(`channel ${plugin.id} failed to start: ${(error as Error).message}`);
    }
  }

  private context(): ChannelContext {
    return {
      onInbound: (m) => this.onInbound(m),
      config: this.deps.config,
      pairing: this.deps.pairing,
      approvals: this.deps.approvals,
      log: this.deps.log,
    };
  }

  async onInbound(m: InboundMessage): Promise<void> {
    const config = this.deps.config();
    const chan = m.channel === 'telegram' ? config.channels.telegram : undefined;
    const plugin = this.plugins.get(m.channel);
    if (!plugin) return;
    const allowFrom = chan?.allowFrom ?? [];

    if (m.chatType === 'dm') {
      const policy = chan?.dmPolicy ?? 'pairing';
      if (policy === 'disabled') return;
      const allowed =
        policy === 'open' || (await this.deps.pairing.isAllowed(m.channel, m.senderId, allowFrom));
      if (!allowed) {
        if (policy === 'pairing') {
          const req = await this.deps.pairing.request(m.channel, m.senderId, m.senderName);
          this.deps.log.info(`pairing request from ${m.channel}:${m.senderId}`, {
            code: req?.code,
          });
          if (req?.created) {
            await plugin.send(
              m.chatId,
              `OpenPulse: access not configured.\n\nYour ${plugin.label} user id: ${m.senderId}\n\nPairing code: ${req.code}\n\nAsk the owner to approve with:\nopenpulse pairing approve ${m.channel} ${req.code}`,
            );
          }
        } else {
          this.deps.log.warn(`dropped DM from ${m.channel}:${m.senderId} (not in allowlist)`);
        }
        return;
      }
    } else {
      const groupCfg = chan?.groups?.[m.chatId] ?? chan?.groups?.['*'];
      if (chan?.groups && !groupCfg) return; // groups configured as an allowlist
      const gp = groupCfg?.groupPolicy ?? chan?.groupPolicy ?? 'allowlist';
      if (gp === 'disabled') return;
      if (
        gp === 'allowlist' &&
        !(await this.deps.pairing.isAllowed(
          m.channel,
          m.senderId,
          chan?.groupAllowFrom ?? allowFrom,
        ))
      )
        return;
      if ((groupCfg?.requireMention ?? true) && !m.mentioned) return;
    }

    const sessionKey = resolveSessionKey(
      {
        channel: m.channel,
        peerKind: m.chatType,
        peerId: m.chatType === 'dm' ? m.senderId : m.chatId,
        ...(m.threadId !== undefined && { threadId: m.threadId }),
      },
      { dmScope: config.session.dmScope, mainKey: config.session.mainKey },
    );
    await this.deps.sessions.ensure(sessionKey, {
      ...(m.senderName !== undefined && {
        displayName: m.chatType === 'dm' ? m.senderName : `${m.channel} group ${m.chatId}`,
      }),
    });
    const to = m.threadId ? `${m.chatId}:topic:${m.threadId}` : m.chatId;
    await this.deps.sessions.patch(sessionKey, {
      lastChannel: m.channel,
      lastTo: to,
      lastInteractionAt: Date.now(),
    });
    this.deps.log.info(`inbound ${m.channel}:${m.senderId} → ${sessionKey}`, {
      text: m.text.slice(0, 120),
    });

    const stopTyping = this.keepTyping(plugin, to, sessionKey);
    const result = await this.deps.agent.dispatch({
      sessionKey,
      message: m.text,
      source: {
        kind: 'user',
        channel: m.channel,
        to,
        senderId: m.senderId,
        ...(m.senderName !== undefined && { senderName: m.senderName }),
      },
      deliver: async (text) => {
        stopTyping();
        await plugin.send(to, text);
      },
    });
    if (result.status === 'command') stopTyping();
  }

  private keepTyping(plugin: ChannelPlugin, to: string, sessionKey: string): () => void {
    if (!plugin.typing) return () => undefined;
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      void plugin.typing!(to).catch(() => undefined);
    };
    tick();
    const timer = setInterval(() => {
      if (!this.deps.agent.isBusy(sessionKey)) stop();
      else tick();
    }, 4000);
    const stop = () => {
      stopped = true;
      clearInterval(timer);
    };
    return stop;
  }

  /** Send exec approval prompts to the chat the run's session last talked to. */
  private async promptApproval(a: ExecApprovalRequest): Promise<void> {
    const entry = await this.deps.sessions.get(a.request.sessionKey);
    const channel = entry?.lastChannel;
    const plugin = channel ? this.plugins.get(channel) : undefined;
    if (!plugin || !entry?.lastTo) return;
    try {
      if (plugin.approvalPrompt) await plugin.approvalPrompt(entry.lastTo, a);
      else
        await plugin.send(
          entry.lastTo,
          `Exec approval required: ${a.request.command}\nReply /approve ${a.id} allow-once|allow-always|deny`,
        );
    } catch (error) {
      this.deps.log.warn(`approval prompt delivery failed: ${(error as Error).message}`);
    }
  }

  private async approvalDone(r: ExecApprovalResolved): Promise<void> {
    for (const p of this.plugins.values())
      await p.approvalResolved?.(r.id, r.decision, r.resolvedBy).catch(() => undefined);
  }
}
