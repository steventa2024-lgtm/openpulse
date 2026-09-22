import { loadOrCreateIdentity, signChallenge, type BrowserIdentity } from './identity.js';

export type Frame =
  | { type: 'req'; id: string; method: string; params?: unknown }
  | {
      type: 'res';
      id: string;
      ok: boolean;
      payload?: unknown;
      error?: { code: string; message: string; details?: unknown };
    }
  | { type: 'event'; event: string; payload: unknown; seq?: number };

export interface HelloOk {
  protocol: number;
  server: { version: string; connId: string; host: string; startedAtMs: number };
  features: { methods: string[]; events: string[] };
  snapshot: {
    presence: unknown[];
    health: unknown;
    sessionDefaults: { mainSessionKey: string; agentId: string };
  };
  auth: { role: string; scopes: string[]; deviceToken?: string };
}

export type ConnectionState =
  'connecting' | 'open' | 'closed' | 'unauthorized' | 'pairing-required';

export interface ClientStatus {
  state: ConnectionState;
  hello?: HelloOk;
  error?: string;
  attempt: number;
}

export class RequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'RequestError';
  }
}

const PROTOCOL_VERSION = 3;
const DEVICE_TOKEN_KEY = 'openpulse.deviceToken';
const TOKEN_KEY = 'openpulse.token';

type EventHandler = (event: string, payload: unknown) => void;
type StatusHandler = (status: ClientStatus) => void;

/**
 * Browser half of the gateway control plane: challenge/response handshake with this browser's
 * device key, request/response correlation and a fan-out of server events. Reconnects with
 * backoff so the Control UI survives a gateway restart.
 */
export class GatewayConnection {
  private ws: WebSocket | undefined;
  private identity: BrowserIdentity | undefined;
  private nextId = 1;
  private readonly pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number }
  >();
  private readonly eventHandlers = new Set<EventHandler>();
  private readonly statusHandlers = new Set<StatusHandler>();
  private statusValue: ClientStatus = { state: 'connecting', attempt: 0 };
  private retry: number | undefined;
  private closedByUs = false;

  constructor(private readonly url: string) {}

  get status(): ClientStatus {
    return this.statusValue;
  }

  onEvent(handler: EventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    handler(this.statusValue);
    return () => this.statusHandlers.delete(handler);
  }

  setToken(token: string): void {
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      // ignore
    }
    this.reconnect(0);
  }

  start(): void {
    this.closedByUs = false;
    void this.open();
  }

  stop(): void {
    this.closedByUs = true;
    if (this.retry) window.clearTimeout(this.retry);
    this.ws?.close();
    this.ws = undefined;
  }

  async request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 120_000,
  ): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.statusValue.state !== 'open')
      throw new RequestError('CLOSED', 'not connected to the gateway');
    const id = String(this.nextId++);
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new RequestError('TIMEOUT', `${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  }

  // -----------------------------------------------------------------------------------------------

  private setStatus(next: Partial<ClientStatus>): void {
    this.statusValue = { ...this.statusValue, ...next };
    for (const handler of this.statusHandlers) handler(this.statusValue);
  }

  private async open(): Promise<void> {
    this.identity ??= await loadOrCreateIdentity();
    this.setStatus({ state: 'connecting' });
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onmessage = (raw) => {
      let frame: Frame;
      try {
        frame = JSON.parse(String(raw.data)) as Frame;
      } catch {
        return;
      }
      if (frame.type === 'event' && frame.event === 'connect.challenge') {
        void this.sendConnect((frame.payload as { nonce: string }).nonce);
        return;
      }
      if (frame.type === 'res' && frame.id === 'connect') {
        if (frame.ok) {
          const hello = frame.payload as HelloOk;
          if (hello.auth.deviceToken) {
            try {
              localStorage.setItem(DEVICE_TOKEN_KEY, hello.auth.deviceToken);
            } catch {
              // ignore
            }
          }
          this.setStatus({ state: 'open', hello, attempt: 0, error: undefined });
        } else {
          const code = frame.error?.code ?? 'UNAUTHORIZED';
          this.setStatus({
            state: code === 'PAIRING_REQUIRED' ? 'pairing-required' : 'unauthorized',
            error: frame.error?.message ?? 'the gateway rejected this browser',
          });
        }
        return;
      }
      this.onFrame(frame);
    };

    ws.onclose = () => {
      for (const [, p] of this.pending) {
        window.clearTimeout(p.timer);
        p.reject(new RequestError('CLOSED', 'connection closed'));
      }
      this.pending.clear();
      if (this.closedByUs) return;
      if (
        this.statusValue.state === 'unauthorized' ||
        this.statusValue.state === 'pairing-required'
      )
        return;
      const attempt = this.statusValue.attempt + 1;
      this.setStatus({ state: 'closed', attempt });
      this.reconnect(Math.min(500 * 2 ** Math.min(attempt, 5), 10_000));
    };

    ws.onerror = () => {
      // handled by onclose
    };
  }

  private reconnect(delayMs: number): void {
    if (this.retry) window.clearTimeout(this.retry);
    this.ws?.close();
    this.ws = undefined;
    this.retry = window.setTimeout(() => void this.open(), delayMs);
  }

  private async sendConnect(nonce: string): Promise<void> {
    const identity = this.identity!;
    const clientId = 'openpulse-control-ui';
    const device = await signChallenge(identity, { nonce, clientId, role: 'operator' });
    const token = readStorage(TOKEN_KEY) ?? window.__OPENPULSE_TOKEN__;
    const deviceToken = readStorage(DEVICE_TOKEN_KEY);
    this.ws?.send(
      JSON.stringify({
        type: 'req',
        id: 'connect',
        method: 'connect',
        params: {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: {
            id: clientId,
            displayName: 'Control UI',
            version: '0.1.0',
            platform: navigator.platform || 'browser',
            mode: 'ui',
          },
          role: 'operator',
          auth: { ...(token ? { token } : {}), ...(deviceToken ? { deviceToken } : {}) },
          device,
        },
      }),
    );
  }

  private onFrame(frame: Frame): void {
    if (frame.type === 'res') {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      this.pending.delete(frame.id);
      window.clearTimeout(pending.timer);
      if (frame.ok) pending.resolve(frame.payload);
      else
        pending.reject(
          new RequestError(
            frame.error?.code ?? 'INTERNAL',
            frame.error?.message ?? 'request failed',
            frame.error?.details,
          ),
        );
      return;
    }
    if (frame.type === 'event') {
      for (const handler of this.eventHandlers) handler(frame.event, frame.payload);
    }
  }
}

function readStorage(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

declare global {
  interface Window {
    __OPENPULSE_TOKEN__?: string;
  }
}

/** Ask the gateway for the Control UI bootstrap (token when served over loopback). */
export async function fetchControlConfig(
  origin: string,
): Promise<{ authMode: string; token?: string; version: string; assistantName: string }> {
  const response = await fetch(`${origin}/control-config`);
  if (!response.ok) throw new Error(`control-config failed (${response.status})`);
  return (await response.json()) as {
    authMode: string;
    token?: string;
    version: string;
    assistantName: string;
  };
}
