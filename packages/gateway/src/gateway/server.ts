import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { Runtime } from '../runtime.js';
import { VERSION } from '../version.js';
import { deviceIdFromPublicKey, verifyDeviceSignature } from './devices.js';
import { METHODS, type MethodContext } from './methods.js';
import {
  ConnectParamsSchema,
  deviceSignaturePayload,
  GatewayError,
  GATEWAY_EVENTS,
  MAX_PAYLOAD,
  PROTOCOL_VERSION,
  TICK_INTERVAL_MS,
  type ConnectParams,
  type Frame,
} from './protocol.js';

interface Connection {
  id: string;
  ws: WebSocket;
  authed: boolean;
  nonce: string;
  ip: string;
  loopback: boolean;
  role: 'operator' | 'node';
  client: ConnectParams['client'];
  deviceId?: string;
  connectedAtMs: number;
  lastSeenAtMs: number;
  caps: string[];
}

export interface ServerOptions {
  /** Directory of the built Control UI; false disables serving it. */
  controlUiDir?: string | false;
  host?: string;
  port?: number;
}

const HANDSHAKE_TIMEOUT_MS = 15_000;

/**
 * The gateway: one HTTP server that serves the Control UI and channel webhooks, plus the
 * WebSocket control plane (req/res/event frames) every client speaks.
 */
export class GatewayServer {
  private readonly http: http.Server;
  private readonly wss: WebSocketServer;
  private readonly connections = new Map<string, Connection>();
  private seq = 0;
  private tickTimer: NodeJS.Timeout | undefined;
  private actualPort = 0;

  constructor(
    private readonly rt: Runtime,
    private readonly options: ServerOptions = {},
  ) {
    this.http = http.createServer((req, res) => void this.handleHttp(req, res));
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
    this.http.on('upgrade', (req, socket, head) => {
      if (!this.originAllowed(req)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, req));
    });
    this.wireEvents();
  }

  get port(): number {
    return this.actualPort;
  }

  get url(): string {
    const host = this.bindHost() === '0.0.0.0' ? '127.0.0.1' : this.bindHost();
    return `http://${host}:${this.actualPort}`;
  }

  async listen(): Promise<void> {
    const port = this.options.port ?? this.rt.cfg.gateway.port;
    const host = this.bindHost();
    await new Promise<void>((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(port, host, () => {
        this.http.off('error', reject);
        resolve();
      });
    });
    const addr = this.http.address();
    this.actualPort = typeof addr === 'object' && addr ? addr.port : port;
    this.tickTimer = setInterval(
      () => this.broadcast('tick', { ts: Date.now() }),
      TICK_INTERVAL_MS,
    );
    this.tickTimer.unref();
    this.rt.log.info(`gateway listening on ${host}:${this.actualPort}`, {
      controlUi: this.rt.cfg.gateway.controlUi.enabled,
    });
  }

  async close(): Promise<void> {
    clearInterval(this.tickTimer);
    this.broadcast('shutdown', { ts: Date.now() });
    for (const c of this.connections.values()) c.ws.close(1001, 'gateway shutting down');
    this.connections.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  presence(): unknown[] {
    const self = {
      id: 'gateway',
      host: os.hostname(),
      mode: 'gateway',
      role: 'gateway',
      platform: process.platform,
      version: VERSION,
      connectedAtMs: this.rt.startedAt,
      lastSeenAtMs: Date.now(),
      ip: '127.0.0.1',
    };
    return [
      self,
      ...[...this.connections.values()]
        .filter((c) => c.authed)
        .map((c) => ({
          id: c.id,
          host: c.client.displayName ?? c.client.id,
          clientId: c.client.id,
          mode: c.client.mode,
          role: c.role,
          platform: c.client.platform,
          version: c.client.version,
          deviceId: c.deviceId,
          ip: c.ip,
          connectedAtMs: c.connectedAtMs,
          lastSeenAtMs: c.lastSeenAtMs,
          caps: c.caps,
        })),
    ];
  }

  broadcast(event: string, payload: unknown): void {
    const frame = JSON.stringify({ type: 'event', event, payload, seq: ++this.seq });
    for (const c of this.connections.values()) {
      if (c.authed && c.ws.readyState === c.ws.OPEN) c.ws.send(frame);
    }
  }

  // -----------------------------------------------------------------------------------------------

  private bindHost(): string {
    if (this.options.host) return this.options.host;
    return this.rt.cfg.gateway.bind === 'lan' ? '0.0.0.0' : '127.0.0.1';
  }

  private wireEvents(): void {
    this.rt.emitChange = (changeId, projectId) =>
      this.broadcast('changes.changed', { id: changeId, projectId, reason: 'proposed' });
    this.rt.agent.on('chat', (e) => this.broadcast('chat', e));
    this.rt.agent.on('agent', (e) => this.broadcast('agent', e));
    this.rt.heartbeat.on('heartbeat', (e) => this.broadcast('heartbeat', e));
    this.rt.cron.on('cron', (e) => this.broadcast('cron', e));
    this.rt.approvals.on('requested', (a) => this.broadcast('exec.approval.requested', a));
    this.rt.approvals.on('resolved', (r) => this.broadcast('exec.approval.resolved', r));
    this.rt.devices.on('requested', (r) => this.broadcast('device.pair.requested', r));
    this.rt.devices.on('resolved', (r) => this.broadcast('device.pair.resolved', r));
    this.rt.config.on('change', (snap) =>
      this.broadcast('config.changed', { hash: snap.hash, valid: snap.valid }),
    );
    this.rt.logs.on('record', (r) => {
      if (r.level === 'error' || r.level === 'warn')
        this.broadcast('health', {
          level: r.level,
          msg: r.msg,
          subsystem: r.subsystem,
          ts: r.time,
        });
    });
  }

  private onConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const ip = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    const conn: Connection = {
      id: randomUUID(),
      ws,
      authed: false,
      nonce: randomBytes(16).toString('base64url'),
      ip,
      loopback: isLoopbackIp(ip) && !req.headers['x-forwarded-for'],
      role: 'operator',
      client: { id: 'unknown', version: '0', platform: 'unknown', mode: 'operator' },
      connectedAtMs: Date.now(),
      lastSeenAtMs: Date.now(),
      caps: [],
    };
    this.connections.set(conn.id, conn);

    const handshakeTimer = setTimeout(() => {
      if (!conn.authed) ws.close(1008, 'handshake timeout');
    }, HANDSHAKE_TIMEOUT_MS);

    send(ws, {
      type: 'event',
      event: 'connect.challenge',
      payload: { nonce: conn.nonce, ts: Date.now() },
    });

    ws.on('message', (raw) => void this.onMessage(conn, frameText(raw)));
    ws.on('close', () => {
      clearTimeout(handshakeTimer);
      this.connections.delete(conn.id);
      if (conn.authed) this.broadcast('presence', { presence: this.presence() });
    });
    ws.on('error', () => undefined);
  }

  private async onMessage(conn: Connection, raw: string): Promise<void> {
    conn.lastSeenAtMs = Date.now();
    let frame: Frame;
    try {
      frame = JSON.parse(raw) as Frame;
    } catch {
      conn.ws.close(1003, 'invalid frame');
      return;
    }
    if (frame.type !== 'req') return;

    if (!conn.authed) {
      if (frame.method !== 'connect') {
        conn.ws.close(1008, 'handshake required');
        return;
      }
      await this.handleConnect(conn, frame.id, frame.params);
      return;
    }

    const handler = METHODS[frame.method];
    if (!handler) {
      send(conn.ws, {
        type: 'res',
        id: frame.id,
        ok: false,
        error: { code: 'NOT_FOUND', message: `Unknown method "${frame.method}"` },
      });
      return;
    }
    try {
      const payload = await handler(
        (frame.params ?? {}) as Record<string, unknown>,
        this.methodContext(conn),
      );
      send(conn.ws, { type: 'res', id: frame.id, ok: true, payload });
    } catch (error) {
      const e =
        error instanceof GatewayError
          ? { code: error.code, message: error.message, details: error.details }
          : { code: 'INTERNAL' as const, message: (error as Error).message };
      if (!(error instanceof GatewayError))
        this.rt.log.error(`method ${frame.method} failed: ${e.message}`);
      send(conn.ws, { type: 'res', id: frame.id, ok: false, error: e });
    }
  }

  private methodContext(conn: Connection): MethodContext {
    return {
      rt: this.rt,
      connId: conn.id,
      client: {
        id: conn.client.id,
        mode: conn.client.mode,
        ...(conn.client.displayName !== undefined && { displayName: conn.client.displayName }),
      },
      presence: () => this.presence(),
      connectionCount: () => this.connections.size,
      broadcast: (event, payload) => this.broadcast(event, payload),
    };
  }

  private async handleConnect(conn: Connection, id: string, rawParams: unknown): Promise<void> {
    const parsed = ConnectParamsSchema.safeParse(rawParams);
    if (!parsed.success) {
      send(conn.ws, {
        type: 'res',
        id,
        ok: false,
        error: {
          code: 'INVALID_REQUEST',
          message: parsed.error.issues[0]?.message ?? 'invalid connect params',
        },
      });
      conn.ws.close(1008, 'invalid connect');
      return;
    }
    const p = parsed.data;
    const reject = (
      code: 'UNAUTHORIZED' | 'PAIRING_REQUIRED' | 'INVALID_REQUEST',
      message: string,
      details?: unknown,
    ) => {
      send(conn.ws, { type: 'res', id, ok: false, error: { code, message, details } });
      conn.ws.close(1008, message);
    };

    if (p.minProtocol > PROTOCOL_VERSION || p.maxProtocol < PROTOCOL_VERSION) {
      return reject(
        'INVALID_REQUEST',
        `Unsupported protocol (gateway speaks v${PROTOCOL_VERSION})`,
      );
    }

    const auth = this.rt.cfg.gateway.auth;
    let deviceToken: string | undefined;

    // 1. Device identity (required beyond loopback).
    if (p.device) {
      if (deviceIdFromPublicKey(p.device.publicKey) !== p.device.id)
        return reject('UNAUTHORIZED', 'device id does not match its public key');
      if (p.device.nonce !== conn.nonce)
        return reject('UNAUTHORIZED', 'device signature nonce mismatch');
      if (Math.abs(Date.now() - p.device.signedAt) > 10 * 60_000)
        return reject('UNAUTHORIZED', 'device signature expired');
      const payload = deviceSignaturePayload({
        nonce: p.device.nonce,
        signedAt: p.device.signedAt,
        clientId: p.client.id,
        role: p.role,
      });
      if (!verifyDeviceSignature(p.device.publicKey, payload, p.device.signature))
        return reject('UNAUTHORIZED', 'invalid device signature');
      conn.deviceId = p.device.id;
    } else if (!conn.loopback) {
      return reject('UNAUTHORIZED', 'device identity required for non-loopback connections');
    }

    // 2. Shared secret (loopback does not bypass it) — or a previously issued device token.
    const known = conn.deviceId ? await this.rt.devices.get(conn.deviceId) : undefined;
    const tokenOk =
      auth.mode === 'none' ||
      (auth.mode === 'token' && Boolean(auth.token) && p.auth?.token === auth.token) ||
      (auth.mode === 'password' && Boolean(auth.password) && p.auth?.password === auth.password) ||
      Boolean(
        known && p.auth?.deviceToken && this.rt.devices.checkToken(known, p.auth.deviceToken),
      );
    if (!tokenOk) {
      this.rt.log.warn('rejected connection: bad gateway secret', {
        ip: conn.ip,
        client: p.client.id,
      });
      return reject('UNAUTHORIZED', 'invalid gateway token or password');
    }

    // 3. Pairing: loopback devices are approved silently, others need an operator decision.
    if (conn.deviceId && !known) {
      if (conn.loopback) {
        deviceToken = await this.rt.devices.approve({
          deviceId: conn.deviceId,
          publicKey: p.device!.publicKey,
          role: p.role,
          ...(p.client.displayName !== undefined && { displayName: p.client.displayName }),
          platform: p.client.platform,
          clientId: p.client.id,
        });
        this.rt.log.info(`device auto-approved (loopback): ${conn.deviceId}`, {
          client: p.client.id,
        });
      } else {
        const request = await this.rt.devices.addPending({
          deviceId: conn.deviceId,
          publicKey: p.device!.publicKey,
          role: p.role,
          ...(p.client.displayName !== undefined && { displayName: p.client.displayName }),
          platform: p.client.platform,
          clientId: p.client.id,
          remoteIp: conn.ip,
        });
        this.rt.log.warn(`pairing required for device ${conn.deviceId}`, {
          requestId: request.requestId,
          ip: conn.ip,
        });
        return reject('PAIRING_REQUIRED', 'pairing required', {
          requestId: request.requestId,
          deviceId: conn.deviceId,
        });
      }
    } else if (conn.deviceId && known) {
      await this.rt.devices.touch(conn.deviceId);
    }

    conn.authed = true;
    conn.role = p.role;
    conn.client = p.client;
    conn.caps = p.caps ?? [];

    send(conn.ws, {
      type: 'res',
      id,
      ok: true,
      payload: {
        type: 'hello-ok',
        protocol: PROTOCOL_VERSION,
        server: {
          version: VERSION,
          connId: conn.id,
          host: os.hostname(),
          startedAtMs: this.rt.startedAt,
        },
        features: { methods: Object.keys(METHODS).sort(), events: [...GATEWAY_EVENTS] },
        snapshot: {
          presence: this.presence(),
          health: METHODS.health!({}, this.methodContext(conn)),
          sessionDefaults: { mainSessionKey: this.rt.agent.mainKey, agentId: this.rt.agentId },
        },
        policy: { maxPayload: MAX_PAYLOAD, tickIntervalMs: TICK_INTERVAL_MS },
        auth: {
          role: conn.role,
          scopes: ['operator.read', 'operator.write', 'operator.admin'],
          ...(deviceToken && { deviceToken }),
        },
      },
    });
    this.rt.log.info(`client connected: ${p.client.id} (${p.client.mode})`, {
      ip: conn.ip,
      deviceId: conn.deviceId,
    });
    this.broadcast('presence', { presence: this.presence() });
  }

  private originAllowed(req: http.IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser client
    let hostname: string;
    try {
      hostname = new URL(origin).hostname;
    } catch {
      return false;
    }
    if (isLoopbackIp(hostname) || hostname === 'localhost') return true;
    if (this.rt.cfg.gateway.controlUi.allowedOrigins.includes(origin)) return true;
    const host = (req.headers.host ?? '').split(':')[0];
    return hostname === host;
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === '/health' || pathname === '/api/health') {
      return json(res, 200, {
        ok: true,
        version: VERSION,
        uptimeMs: Date.now() - this.rt.startedAt,
      });
    }

    // The Control UI served on loopback gets the gateway secret here so the operator does not
    // have to paste it; remote browsers must supply their own token.
    if (pathname === '/control-config') {
      const ip = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
      const loopback = isLoopbackIp(ip) && !req.headers['x-forwarded-for'];
      const auth = this.rt.cfg.gateway.auth;
      return json(res, 200, {
        version: VERSION,
        authMode: auth.mode,
        ...(loopback && auth.mode === 'token' && auth.token ? { token: auth.token } : {}),
        assistantName: this.rt.cfg.ui.assistant?.name ?? 'OpenPulse',
      });
    }

    if (pathname.startsWith('/webhooks/')) {
      const channelId = pathname.slice('/webhooks/'.length).split('/')[0] ?? '';
      const plugin = this.rt.channels.get(channelId);
      if (!plugin?.handleWebhook) return json(res, 404, { error: 'unknown channel' });
      const body = await readJson(req);
      const result = await plugin.handleWebhook({
        headers: req.headers,
        body,
      });
      return json(res, result.status, result.body ?? {});
    }

    if (!this.rt.cfg.gateway.controlUi.enabled)
      return json(res, 404, { error: 'control UI disabled' });
    await this.serveControlUi(pathname, res);
  }

  private async serveControlUi(pathname: string, res: http.ServerResponse): Promise<void> {
    const dir =
      this.options.controlUiDir === false
        ? undefined
        : (this.options.controlUiDir ?? resolveControlUiDir());
    if (!dir || !fs.existsSync(path.join(dir, 'index.html'))) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>OpenPulse</title><body style="font-family:system-ui;max-width:42rem;margin:4rem auto;padding:0 1rem;line-height:1.6">
<h1>OpenPulse gateway is running</h1><p>The Control UI has not been built yet. Run <code>pnpm build</code> in the repo, then reload.</p>
<p>WebSocket API: <code>ws://127.0.0.1:${this.actualPort}</code> · <a href="/health">/health</a></p></body>`,
      );
      return;
    }
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    let file = path.join(dir, rel);
    if (
      !file.startsWith(path.resolve(dir)) ||
      !fs.existsSync(file) ||
      fs.statSync(file).isDirectory()
    ) {
      file = path.join(dir, 'index.html'); // SPA fallback for /chat, /sessions, …
    }
    const ext = path.extname(file).toLowerCase();
    const type =
      {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.ico': 'image/x-icon',
        '.json': 'application/json',
        '.woff2': 'font/woff2',
        '.map': 'application/json',
      }[ext] ?? 'application/octet-stream';
    const body = await fsp.readFile(file);
    res.writeHead(200, {
      'content-type': type,
      'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  }
}

/** Locate the built Control UI (packages/dashboard/dist) via the workspace dependency. */
export function resolveControlUiDir(): string | undefined {
  try {
    const pkg = createRequire(import.meta.url).resolve('@openpulse/dashboard/package.json');
    return path.join(path.dirname(pkg), 'dist');
  } catch {
    return undefined;
  }
}

function isLoopbackIp(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('127.') || ip === 'localhost';
}

function send(ws: WebSocket, frame: Frame): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

/** ws hands over a Buffer, a Buffer[] or an ArrayBuffer depending on how the message arrived. */
function frameText(raw: RawData): string {
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return Buffer.from(raw).toString('utf8');
}
