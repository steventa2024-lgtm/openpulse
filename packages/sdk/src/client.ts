import { OpenPulseError } from './errors.js';
import type {
  AgentEvent,
  ChatEvent,
  ChatMessage,
  GatewayEvent,
  HealthSnapshot,
  HelloOk,
  ModelInfo,
  RunResult,
  RunTraceSummary,
  SessionRow,
  TaskUpdate,
  ToolInfo,
  WorkflowExecution,
} from './types.js';

export const PROTOCOL_VERSION = 3;
export const SDK_VERSION = '0.1.0';

/** A device key the gateway recognises, for connecting from beyond this machine. */
export interface DeviceIdentity {
  deviceId: string;
  /** Base64 SPKI public key. */
  publicKey: string;
  /** Signs the connect payload; returns a base64 IEEE-P1363 ECDSA P-256 signature. */
  sign(payload: string): Promise<string>;
}

export interface OpenPulseClientOptions {
  /** Gateway URL, e.g. http://127.0.0.1:18789 (ws:// works too). */
  url?: string;
  /** Shared gateway token (gateway.auth.token). */
  token?: string;
  password?: string;
  /** Token the gateway issued to a paired device. */
  deviceToken?: string;
  /** Required when connecting from another machine; see createDeviceIdentity(). */
  identity?: DeviceIdentity;
  /** Shown in the gateway's list of connected clients. */
  clientName?: string;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Supply a WebSocket implementation where there is no global one. */
  WebSocketImpl?: typeof WebSocket;
}

type Listener = (event: GatewayEvent) => void;

/**
 * Client for the OpenPulse gateway.
 *
 * It speaks the same WebSocket protocol as the CLI and the Control UI — there is no separate SDK
 * API — so everything the dashboard can do, a program can do. Methods return typed results and
 * throw OpenPulseError with the gateway's error code.
 *
 * ```ts
 * const op = await OpenPulseClient.connect({ url: 'http://127.0.0.1:18789', token });
 * for await (const update of op.runTask('Summarise the README')) {
 *   if (update.type === 'text') process.stdout.write(update.delta);
 * }
 * await op.close();
 * ```
 */
export class OpenPulseClient {
  private ws: WebSocket | undefined;
  private nextId = 1;
  private readonly pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly listeners = new Set<Listener>();
  private helloValue: HelloOk | undefined;
  private closedByCaller = false;

  private constructor(private readonly options: OpenPulseClientOptions) {}

  /** Connect and complete the handshake. */
  static async connect(options: OpenPulseClientOptions = {}): Promise<OpenPulseClient> {
    const client = new OpenPulseClient(options);
    await client.open();
    return client;
  }

  get hello(): HelloOk {
    if (!this.helloValue) throw new OpenPulseError('CLOSED', 'Not connected.');
    return this.helloValue;
  }

  get connected(): boolean {
    return this.helloValue !== undefined && this.ws?.readyState === 1;
  }

  /** Methods this gateway supports — useful to detect features on older gateways. */
  supports(method: string): boolean {
    return this.helloValue?.features.methods.includes(method) ?? false;
  }

  // ---- raw protocol --------------------------------------------------------------------------

  /** Call any gateway method. The typed helpers below are thin wrappers over this. */
  async request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1 || !this.helloValue) {
      throw new OpenPulseError('CLOSED', 'Not connected to the gateway.');
    }
    const id = String(this.nextId++);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new OpenPulseError(
            'TIMEOUT',
            `${method} did not answer within ${timeoutMs ?? this.timeout()}ms`,
          ),
        );
      }, timeoutMs ?? this.timeout());
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  }

  /** Receive every event the gateway broadcasts. Returns an unsubscribe function. */
  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Receive one event type, typed. */
  on<T = unknown>(event: string, listener: (payload: T) => void): () => void {
    return this.onEvent((e) => {
      if (e.event === event) listener(e.payload as T);
    });
  }

  async close(): Promise<void> {
    this.closedByCaller = true;
    this.failPending(new OpenPulseError('CLOSED', 'The client was closed.'));
    const ws = this.ws;
    this.ws = undefined;
    this.helloValue = undefined;
    if (!ws || ws.readyState >= 2) return;
    await new Promise<void>((resolve) => {
      ws.addEventListener('close', () => resolve(), { once: true });
      ws.close(1000, 'client closing');
      setTimeout(resolve, 1_000);
    });
  }

  // ---- typed helpers -------------------------------------------------------------------------

  health(): Promise<HealthSnapshot> {
    return this.request('health');
  }

  status(): Promise<HealthSnapshot & Record<string, unknown>> {
    return this.request('status');
  }

  readonly sessions = {
    list: (options: { limit?: number; activeMinutes?: number } = {}) =>
      this.request<{ sessions: SessionRow[] }>('sessions.list', options).then((r) => r.sessions),
    history: (sessionKey = 'main', limit = 100) =>
      this.request<{ sessionKey: string; messages: ChatMessage[]; running: boolean }>(
        'chat.history',
        { sessionKey, limit },
      ),
    reset: (key: string) =>
      this.request<{ key: string; sessionId: string }>('sessions.reset', { key }),
  };

  readonly models = {
    list: () =>
      this.request<{ primary: string; fallbacks: string[]; models: ModelInfo[] }>('models.list'),
    detect: () => this.request<Record<string, unknown>>('models.detect'),
    test: (model: string) =>
      this.request<{ ok: boolean; durationMs: number; text?: string; error?: string }>(
        'models.test',
        { model },
        180_000,
      ),
  };

  readonly tools = {
    list: () =>
      this.request<{ securityMode: string; tools: ToolInfo[] }>('tools.list').then((r) => r.tools),
  };

  readonly runs = {
    list: (
      options: { sessionKey?: string; status?: RunTraceSummary['status']; limit?: number } = {},
    ) => this.request<{ runs: RunTraceSummary[] }>('debug.runs', options).then((r) => r.runs),
    trace: (runId: string) =>
      this.request<{ trace: Record<string, unknown> }>('debug.trace', { runId }).then(
        (r) => r.trace,
      ),
    cancel: (sessionKey = 'main') =>
      this.request<{ aborted: boolean }>('chat.abort', { sessionKey }),
  };

  readonly workflows = {
    list: () => this.request<{ roles: unknown[]; workflows: unknown[] }>('workflows.list'),
    start: (workflowId: string, request: string) =>
      this.request<{ execution: WorkflowExecution }>('workflows.start', {
        workflowId,
        request,
      }).then((r) => r.execution),
    get: (id: string) =>
      this.request<{ execution: WorkflowExecution }>('workflows.execution', { id }).then(
        (r) => r.execution,
      ),
    cancel: (id: string) =>
      this.request<{ execution: WorkflowExecution }>('workflows.cancel', { id }).then(
        (r) => r.execution,
      ),
    /** Resolve when the workflow finishes, calling `onUpdate` on every change. */
    wait: (id: string, onUpdate?: (execution: WorkflowExecution) => void) =>
      new Promise<WorkflowExecution>((resolve, reject) => {
        const off = this.on<{ execution: WorkflowExecution }>(
          'workflows.changed',
          ({ execution }) => {
            if (execution.id !== id) return;
            onUpdate?.(execution);
            if (execution.status !== 'running') {
              off();
              resolve(execution);
            }
          },
        );
        // It may already have finished.
        this.workflows.get(id).then((execution) => {
          if (execution.status !== 'running') {
            off();
            resolve(execution);
          }
        }, reject);
      }),
  };

  /**
   * Run one agent turn and wait for the answer. Use runTask() to stream it instead.
   */
  run(
    message: string,
    options: { sessionKey?: string; timeoutMs?: number } = {},
  ): Promise<RunResult> {
    return this.request<RunResult>(
      'agent',
      { sessionKey: options.sessionKey ?? 'main', message },
      options.timeoutMs ?? 600_000,
    );
  }

  /**
   * Start an agent task and stream what happens: text as it is generated, reasoning, tool calls,
   * approval requests, and the final answer. The iterator ends when the run does.
   */
  async *runTask(
    message: string,
    options: { sessionKey?: string } = {},
  ): AsyncGenerator<TaskUpdate, void, undefined> {
    const queue: TaskUpdate[] = [];
    let wake: (() => void) | undefined;
    let finished = false;
    let runId: string | undefined;
    let sessionKey = options.sessionKey ?? 'main';
    let lastText = '';

    const push = (update: TaskUpdate) => {
      queue.push(update);
      if (update.type === 'done' || update.type === 'aborted' || update.type === 'error')
        finished = true;
      wake?.();
    };

    const matches = (event: { runId: string; sessionKey: string }) =>
      runId ? event.runId === runId : event.sessionKey === sessionKey;

    const offChat = this.on<ChatEvent>('chat', (event) => {
      if (!matches(event)) return;
      const text = textOf(event.message?.content ?? []);
      if (event.state === 'delta') {
        const delta = text.slice(lastText.length);
        lastText = text;
        if (delta) push({ type: 'text', delta, text });
      } else if (event.state === 'final') {
        push({ type: 'done', text, runId: event.runId });
      } else if (event.state === 'aborted') {
        push({ type: 'aborted', text, runId: event.runId });
      } else {
        push({
          type: 'error',
          message: event.errorMessage ?? 'The run failed.',
          runId: event.runId,
        });
      }
    });

    const offAgent = this.on<AgentEvent>('agent', (event) => {
      if (!matches(event)) return;
      if (event.stream === 'thinking' && typeof event.data.delta === 'string') {
        push({ type: 'thinking', delta: event.data.delta });
      }
      if (event.stream === 'tool') {
        push({
          type: 'tool',
          phase: event.data.phase === 'start' ? 'start' : 'result',
          name: typeof event.data.name === 'string' ? event.data.name : 'tool',
          ...(typeof event.data.summary === 'string' && { summary: event.data.summary }),
          ...(typeof event.data.isError === 'boolean' && { isError: event.data.isError }),
          ...(typeof event.data.durationMs === 'number' && { durationMs: event.data.durationMs }),
        });
      }
    });

    const offApproval = this.on<{
      id: string;
      request: { sessionKey: string; command: string; risk: { reason: string } };
    }>('exec.approval.requested', (approval) => {
      if (approval.request.sessionKey !== sessionKey) return;
      push({
        type: 'approval',
        id: approval.id,
        command: approval.request.command,
        reason: approval.request.risk.reason,
      });
    });

    try {
      const history = await this.request<{ sessionKey: string }>('chat.history', {
        sessionKey,
        limit: 1,
      });
      sessionKey = history.sessionKey;
      const started = await this.request<{ runId: string | null; status: string }>('chat.send', {
        sessionKey,
        message,
      });
      if (!started.runId) {
        // A chat command ("/status") answers immediately with no run.
        push({ type: 'done', text: '', runId: '' });
      } else {
        runId = started.runId;
      }

      while (!finished || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
          continue;
        }
        yield queue.shift()!;
      }
    } finally {
      offChat();
      offAgent();
      offApproval();
    }
  }

  /** Answer an approval request raised during a run. */
  approve(id: string, decision: 'allow-once' | 'allow-always' | 'deny'): Promise<{ ok: boolean }> {
    return this.request('exec.approval.resolve', { id, decision });
  }

  // ---- connection ----------------------------------------------------------------------------

  private timeout(): number {
    return this.options.timeoutMs ?? 120_000;
  }

  private async open(): Promise<void> {
    const Impl =
      this.options.WebSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!Impl) {
      throw new OpenPulseError(
        'CONNECT_FAILED',
        'No WebSocket implementation is available. Use Node 22+ or pass WebSocketImpl.',
      );
    }
    const url = (this.options.url ?? 'http://127.0.0.1:18789').replace(/^http/, 'ws');
    const ws = new Impl(url);
    this.ws = ws;

    this.helloValue = await new Promise<HelloOk>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new OpenPulseError('TIMEOUT', `The gateway at ${url} did not complete the handshake.`),
        );
        ws.close();
      }, this.options.timeoutMs ?? 15_000);

      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new OpenPulseError('CONNECT_FAILED', `Could not connect to the gateway at ${url}.`));
      });

      ws.addEventListener('close', (event) => {
        clearTimeout(timer);
        this.helloValue = undefined;
        this.failPending(new OpenPulseError('CLOSED', `Connection closed (${event.code}).`));
        reject(
          new OpenPulseError(
            event.code === 1008 ? 'UNAUTHORIZED' : 'CLOSED',
            event.reason || `Connection closed (${event.code}).`,
          ),
        );
      });

      ws.addEventListener('message', (message) => {
        let frame: {
          type: string;
          id?: string;
          ok?: boolean;
          payload?: unknown;
          error?: { code: string; message: string; details?: unknown };
          event?: string;
          seq?: number;
        };
        try {
          frame = JSON.parse(String(message.data)) as typeof frame;
        } catch {
          return;
        }
        if (frame.type === 'event' && frame.event === 'connect.challenge') {
          void this.sendConnect((frame.payload as { nonce: string }).nonce).catch(
            (error: unknown) =>
              reject(
                error instanceof Error
                  ? error
                  : new OpenPulseError('CONNECT_FAILED', String(error)),
              ),
          );
          return;
        }
        if (frame.type === 'res' && frame.id === 'connect') {
          clearTimeout(timer);
          if (frame.ok) resolve(frame.payload as HelloOk);
          else
            reject(
              new OpenPulseError(
                frame.error?.code ?? 'UNAUTHORIZED',
                frame.error?.message ?? 'The gateway refused the connection.',
                frame.error?.details,
              ),
            );
          return;
        }
        if (frame.type === 'res' && frame.id) {
          const pending = this.pending.get(frame.id);
          if (!pending) return;
          this.pending.delete(frame.id);
          clearTimeout(pending.timer);
          if (frame.ok) pending.resolve(frame.payload);
          else
            pending.reject(
              new OpenPulseError(
                frame.error?.code ?? 'INTERNAL',
                frame.error?.message ?? 'Request failed.',
                frame.error?.details,
              ),
            );
          return;
        }
        if (frame.type === 'event' && frame.event) {
          const event: GatewayEvent = {
            event: frame.event,
            payload: frame.payload,
            ...(frame.seq !== undefined && { seq: frame.seq }),
          };
          for (const listener of this.listeners) listener(event);
        }
      });
    });

    void this.closedByCaller;
  }

  private async sendConnect(nonce: string): Promise<void> {
    const clientId = 'openpulse-sdk';
    const role = 'operator';
    let device: Record<string, unknown> | undefined;
    if (this.options.identity) {
      const signedAt = Date.now();
      const payload = `openpulse-connect|v1|${nonce}|${signedAt}|${clientId}|${role}`;
      device = {
        id: this.options.identity.deviceId,
        publicKey: this.options.identity.publicKey,
        signature: await this.options.identity.sign(payload),
        signedAt,
        nonce,
      };
    }
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
            displayName: this.options.clientName ?? 'OpenPulse SDK',
            version: SDK_VERSION,
            // No Node types in the published build: the SDK has to compile for browsers too.
            platform:
              (globalThis as { process?: { platform?: string } }).process?.platform ?? 'browser',
            mode: 'operator',
          },
          role,
          auth: {
            ...(this.options.token !== undefined && { token: this.options.token }),
            ...(this.options.password !== undefined && { password: this.options.password }),
            ...(this.options.deviceToken !== undefined && {
              deviceToken: this.options.deviceToken,
            }),
          },
          ...(device && { device }),
        },
      }),
    );
  }

  private failPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function textOf(content: { type: string; text?: unknown }[]): string {
  return content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('');
}

/**
 * Create a device identity with WebCrypto (Node 22+ and browsers). Persist `exported` somewhere
 * safe and pass it to `importDeviceIdentity` next time, so the gateway recognises the same device.
 */
export async function createDeviceIdentity(): Promise<{
  identity: DeviceIdentity;
  exported: ExportedIdentity;
}> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const exported: ExportedIdentity = {
    publicKeyJwk: await crypto.subtle.exportKey('jwk', pair.publicKey),
    privateKeyJwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
  };
  return { identity: await importDeviceIdentity(exported), exported };
}

export interface ExportedIdentity {
  publicKeyJwk: JsonWebKey;
  privateKeyJwk: JsonWebKey;
}

export async function importDeviceIdentity(exported: ExportedIdentity): Promise<DeviceIdentity> {
  const algorithm = { name: 'ECDSA', namedCurve: 'P-256' };
  const publicKey = await crypto.subtle.importKey('jwk', exported.publicKeyJwk, algorithm, true, [
    'verify',
  ]);
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    exported.privateKeyJwk,
    algorithm,
    false,
    ['sign'],
  );
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', publicKey));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', spki));
  const deviceId = [...digest]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
  return {
    deviceId,
    publicKey: toBase64(spki),
    sign: async (payload) =>
      toBase64(
        new Uint8Array(
          await crypto.subtle.sign(
            { name: 'ECDSA', hash: 'SHA-256' },
            privateKey,
            new TextEncoder().encode(payload),
          ),
        ),
      ),
  };
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
