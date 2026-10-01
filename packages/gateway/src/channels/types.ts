import type { ExecApprovalRequest, ExecApprovals } from '../approvals/exec-approvals.js';
import type { OpenPulseConfig } from '../config/schema.js';
import type { Logger } from '../infra/logger.js';
import type { PairingStore } from './pairing-store.js';
import type { RoutesStore } from '../sessions/routes.js';

export interface InboundMessage {
  channel: string;
  accountId?: string;
  chatId: string;
  chatType: 'dm' | 'group';
  senderId: string;
  senderName?: string;
  text: string;
  threadId?: string;
  /** Explicit @mention / reply-to-bot in a group. */
  mentioned: boolean;
  messageId?: string;
}

export interface ChannelStatus {
  id: string;
  label: string;
  configured: boolean;
  running: boolean;
  connected: boolean;
  mode?: string;
  accountName?: string;
  lastStartAt?: number;
  lastError?: string;
  lastInboundAt?: number;
  lastOutboundAt?: number;
  details?: Record<string, unknown>;
}

export interface ChannelContext {
  onInbound(message: InboundMessage): Promise<void>;
  routes: RoutesStore;
  config(): OpenPulseConfig;
  pairing: PairingStore;
  approvals: ExecApprovals;
  log: Logger;
}

/** A messaging integration. The gateway only talks to channels through this interface. */
export interface ChannelPlugin {
  readonly id: string;
  readonly label: string;
  start(ctx: ChannelContext): Promise<void>;
  stop(): Promise<void>;
  status(): ChannelStatus;
  send(to: string, text: string): Promise<void>;
  /** Optional: same as send(), but may render embedded attachments (e.g. markdown image paths) as native attachments. */
  sendWithPhotos?(to: string, text: string): Promise<void>;
  typing?(to: string): Promise<void>;
  /** Present an exec approval prompt (buttons where supported). */
  approvalPrompt?(to: string, approval: ExecApprovalRequest): Promise<void>;
  approvalResolved?(id: string, decision: string, by: string): Promise<void>;
  probe?(): Promise<Record<string, unknown>>;
  handleWebhook?(req: {
    headers: Record<string, string | string[] | undefined>;
    body: unknown;
  }): Promise<{ status: number; body?: unknown }>;
}
