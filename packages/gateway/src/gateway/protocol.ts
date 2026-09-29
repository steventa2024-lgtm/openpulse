import { z } from 'zod';

export const PROTOCOL_VERSION = 3;
export const TICK_INTERVAL_MS = 15_000;
export const MAX_PAYLOAD = 25 * 1024 * 1024;

export type ErrorCode =
  | 'INVALID_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNAVAILABLE'
  | 'PAIRING_REQUIRED'
  | 'INTERNAL';

export interface ReqFrame {
  type: 'req';
  id: string;
  method: string;
  params?: unknown;
}

export interface ResFrame {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: ErrorCode; message: string; details?: unknown };
}

export interface EventFrame {
  type: 'event';
  event: string;
  payload: unknown;
  seq?: number;
}

export type Frame = ReqFrame | ResFrame | EventFrame;

export const ConnectParamsSchema = z.object({
  minProtocol: z.number().int(),
  maxProtocol: z.number().int(),
  client: z.object({
    id: z.string().min(1),
    displayName: z.string().optional(),
    version: z.string().default('0'),
    platform: z.string().default('unknown'),
    mode: z.enum(['operator', 'node', 'webchat', 'cli', 'ui', 'backend']).default('operator'),
  }),
  role: z.enum(['operator', 'node']).default('operator'),
  scopes: z.array(z.string()).optional(),
  caps: z.array(z.string()).optional(),
  commands: z.array(z.string()).optional(),
  auth: z
    .object({
      token: z.string().optional(),
      password: z.string().optional(),
      deviceToken: z.string().optional(),
    })
    .optional(),
  device: z
    .object({
      id: z.string(),
      publicKey: z.string(),
      signature: z.string(),
      signedAt: z.number(),
      nonce: z.string(),
    })
    .optional(),
  locale: z.string().optional(),
  userAgent: z.string().optional(),
});

export type ConnectParams = z.output<typeof ConnectParamsSchema>;

export class GatewayError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

/** String the client signs to prove possession of its device key. */
export function deviceSignaturePayload(p: {
  nonce: string;
  signedAt: number;
  clientId: string;
  role: string;
}): string {
  return `openpulse-connect|v1|${p.nonce}|${p.signedAt}|${p.clientId}|${p.role}`;
}

export const GATEWAY_EVENTS = [
  'connect.challenge',
  'tick',
  'presence',
  'health',
  'chat',
  'agent',
  'heartbeat',
  'cron',
  'exec.approval.requested',
  'exec.approval.resolved',
  'device.pair.requested',
  'device.pair.resolved',
  'sessions.changed',
  'projects.changed',
  'workspace.changed',
  'config.changed',
  'shutdown',
] as const;
