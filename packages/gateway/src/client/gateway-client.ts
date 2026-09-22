import { EventEmitter } from 'node:events';
import { WebSocket, type RawData } from 'ws';
import { PROTOCOL_VERSION, type Frame } from '../gateway/protocol.js';
import { VERSION } from '../version.js';
import { signChallenge, type DeviceIdentity } from './identity.js';

export interface GatewayClientOptions {
  /** ws:// or http:// URL of the gateway. */
  url: string;
  token?: string;
  password?: string;
  deviceToken?: string;
  identity?: DeviceIdentity;
  clientId?: string;
  displayName?: string;
  mode?: 'operator' | 'cli' | 'ui' | 'webchat' | 'node';
  role?: 'operator' | 'node';
  timeoutMs?: number;
}

export interface HelloOk {
  protocol: number;
  server: { version: string; connId: string; host: string; startedAtMs: number };
  features: { methods: string[]; events: string[] };
  snapshot: Record<string, unknown>;
  policy: { maxPayload: number; tickIntervalMs: number };
  auth: { role: string; scopes: string[]; deviceToken?: string };
}

export class GatewayClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'GatewayClientError';
  }
}

type Events = {
  event: [{ event: string; payload: unknown; seq?: number }];
  close: [{ code: number; reason: string }];
};

/** Node client for the gateway WebSocket protocol (used by the CLI and tests). */
export class GatewayClient extends EventEmitter<Events> {
  private ws: WebSocket | undefined;
  private nextId = 1;
  private readonly pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private helloValue: HelloOk | undefined;

  constructor(private readonly options: GatewayClientOptions) {
    super();
  }

  get hello(): HelloOk | undefined {
    return this.helloValue;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.helloValue !== undefined;
  }

  async connect(): Promise<HelloOk> {
    const url = this.options.url.replace(/^http/, 'ws');
    const timeoutMs = this.options.timeoutMs ?? 15_000;
    const ws = new WebSocket(url, { handshakeTimeout: timeoutMs });
    this.ws = ws;

    const hello = await new Promise<HelloOk>((resolve, reject) => {
      const fail = (e: Error) => {
        cleanup();
        reject(e);
      };
      const timer = setTimeout(
        () =>
          fail(new GatewayClientError('TIMEOUT', `Gateway did not answer within ${timeoutMs}ms`)),
        timeoutMs,
      );
      const cleanup = () => clearTimeout(timer);

      ws.on('error', (e) => fail(new GatewayClientError('CONNECT_FAILED', e.message)));
      ws.on('close', (code, reason) => {
        this.helloValue = undefined;
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(
            new GatewayClientError('CLOSED', `connection closed (${code}) ${reason.toString()}`),
          );
        }
        this.pending.clear();
        this.emit('close', { code, reason: reason.toString() });
        if (!this.helloValue)
          fail(
            new GatewayClientError(
              code === 1008 ? 'UNAUTHORIZED' : 'CLOSED',
              reason.toString() || `closed with ${code}`,
            ),
          );
      });
      ws.on('message', (raw) => {
        let frame: Frame;
        try {
          frame = JSON.parse(frameText(raw)) as Frame;
        } catch {
          return;
        }
        if (frame.type === 'event' && frame.event === 'connect.challenge') {
          const nonce = (frame.payload as { nonce: string }).nonce;
          this.send({
            type: 'req',
            id: 'connect',
            method: 'connect',
            params: this.connectParams(nonce),
          });
          return;
        }
        if (frame.type === 'res' && frame.id === 'connect') {
          cleanup();
          if (!frame.ok) {
            const err = frame.error ?? { code: 'UNAUTHORIZED', message: 'connect rejected' };
            reject(new GatewayClientError(err.code, err.message, err.details));
            return;
          }
          this.helloValue = frame.payload as HelloOk;
          resolve(this.helloValue);
          return;
        }
        this.onFrame(frame);
      });
    });
    return hello;
  }

  async request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN)
      throw new GatewayClientError('CLOSED', 'not connected');
    const id = String(this.nextId++);
    const ms = timeoutMs ?? this.options.timeoutMs ?? 120_000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new GatewayClientError('TIMEOUT', `${method} timed out after ${ms}ms`));
      }, ms);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send({ type: 'req', id, method, params });
    });
  }

  close(): void {
    this.ws?.close(1000, 'client closing');
    this.ws = undefined;
    this.helloValue = undefined;
  }

  private onFrame(frame: Frame): void {
    if (frame.type === 'res') {
      const p = this.pending.get(frame.id);
      if (!p) return;
      this.pending.delete(frame.id);
      clearTimeout(p.timer);
      if (frame.ok) p.resolve(frame.payload);
      else
        p.reject(
          new GatewayClientError(
            frame.error?.code ?? 'INTERNAL',
            frame.error?.message ?? 'request failed',
            frame.error?.details,
          ),
        );
      return;
    }
    if (frame.type === 'event')
      this.emit('event', {
        event: frame.event,
        payload: frame.payload,
        ...(frame.seq !== undefined && { seq: frame.seq }),
      });
  }

  private connectParams(nonce: string): Record<string, unknown> {
    const clientId = this.options.clientId ?? 'openpulse-cli';
    const role = this.options.role ?? 'operator';
    return {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: clientId,
        ...(this.options.displayName !== undefined && { displayName: this.options.displayName }),
        version: VERSION,
        platform: process.platform,
        mode: this.options.mode ?? 'cli',
      },
      role,
      auth: {
        ...(this.options.token !== undefined && { token: this.options.token }),
        ...(this.options.password !== undefined && { password: this.options.password }),
        ...(this.options.deviceToken !== undefined && { deviceToken: this.options.deviceToken }),
      },
      ...(this.options.identity && {
        device: signChallenge(this.options.identity, { nonce, clientId, role }),
      }),
    };
  }

  private send(frame: Frame): void {
    this.ws?.send(JSON.stringify(frame));
  }
}

/** ws hands over a Buffer, a Buffer[] or an ArrayBuffer depending on how the message arrived. */
function frameText(raw: RawData): string {
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return Buffer.from(raw).toString('utf8');
}
