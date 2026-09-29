import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type net from 'node:net';
import { probePort } from './port-probe.js';

export type GatewayState =
  'idle' | 'probing' | 'starting' | 'ready' | 'attached' | 'restarting' | 'failed' | 'stopped';

export interface GatewayStatus {
  state: GatewayState;
  /** True when this process started the gateway and is responsible for stopping it. */
  owned: boolean;
  url?: string;
  port?: number;
  pid?: number;
  version?: string;
  /** Operator-facing explanation when state is "failed". */
  error?: string;
  /** How to get out of the current failure, when there is something to do. */
  hint?: string;
  restarts: number;
  startedAt?: number;
  lastHealthyAt?: number;
}

export interface SupervisorOptions {
  /** Absolute path to the bundled gateway entry (ESM). */
  entry: string;
  /** Electron's own binary; run with ELECTRON_RUN_AS_NODE so users need no Node install. */
  nodeBin: string;
  port: number;
  stateDir?: string;
  /** Extra environment for the gateway process (control UI dir, skills dir…). */
  env?: Record<string, string>;
  /** How many ports after the preferred one to try when it is taken by another application. */
  portFallbacks?: number;
  /** Injected for tests. */
  spawnFn?: typeof spawn;
  fetchFn?: typeof fetch;
  connectFn?: typeof net.connect;
  now?: () => number;
  /** Health poll interval once the gateway is up. */
  healthIntervalMs?: number;
  /** How long to wait for a freshly spawned gateway to answer /health. */
  startTimeoutMs?: number;
  maxRestarts?: number;
  onLog?: (line: string, stream: 'stdout' | 'stderr') => void;
}

const RESTART_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/**
 * Owns the gateway process for the desktop app.
 *
 * It attaches to a gateway that is already running (so a developer's `openpulse gateway` keeps
 * working), starts its own when the port is free, watches health, and restarts what it started.
 * It never kills a process it did not spawn.
 */
export class GatewaySupervisor extends EventEmitter<{
  status: [GatewayStatus];
  log: [{ line: string; stream: 'stdout' | 'stderr' }];
}> {
  private child: ChildProcess | undefined;
  private healthTimer: NodeJS.Timeout | undefined;
  private restartTimer: NodeJS.Timeout | undefined;
  private stopping = false;
  private statusValue: GatewayStatus = { state: 'idle', owned: false, restarts: 0 };
  private readonly fetchFn: typeof fetch;
  private readonly spawnFn: typeof spawn;
  /** The port actually in use, which can differ from the preferred one after a conflict. */
  private activePort: number;
  private readonly now: () => number;
  private readonly recentLogs: string[] = [];

  constructor(private readonly options: SupervisorOptions) {
    super();
    this.fetchFn = options.fetchFn ?? fetch;
    this.spawnFn = options.spawnFn ?? spawn;
    this.now = options.now ?? Date.now;
    this.activePort = options.port;
  }

  get status(): GatewayStatus {
    return this.statusValue;
  }

  get url(): string {
    return `http://127.0.0.1:${this.activePort}`;
  }

  get port(): number {
    return this.activePort;
  }

  /** The last lines the gateway printed — shown in diagnostics when startup fails. */
  logTail(limit = 200): string[] {
    return this.recentLogs.slice(-limit);
  }

  /**
   * Find a usable port and either attach to the gateway already on it or start our own.
   *
   * The preferred port is tried first. If another application holds it, the next few ports are
   * tried rather than failing outright — and nothing belonging to another process is ever killed.
   */
  async start(): Promise<GatewayStatus> {
    this.stopping = false;
    this.setStatus({ state: 'probing' });

    const fallbacks = this.options.portFallbacks ?? 10;
    const taken: number[] = [];

    for (let offset = 0; offset <= fallbacks; offset += 1) {
      const port = this.options.port + offset;
      const probe = await probePort(port, {
        fetchFn: this.fetchFn,
        ...(this.options.connectFn && { connectFn: this.options.connectFn }),
      });

      if (probe.occupant === 'openpulse') {
        this.activePort = port;
        this.setStatus({
          state: 'attached',
          owned: false,
          url: this.url,
          port,
          ...(probe.version !== undefined && { version: probe.version }),
          lastHealthyAt: this.now(),
          error: undefined,
          hint: undefined,
        });
        this.watchHealth();
        return this.statusValue;
      }

      if (probe.occupant === 'free') {
        this.activePort = port;
        if (taken.length > 0) {
          this.emit('log', {
            line: `port ${this.options.port} is in use by another application; using ${port} instead`,
            stream: 'stdout',
          });
        }
        return this.spawnGateway();
      }

      taken.push(port);
    }

    return this.fail(
      `Ports ${taken[0]}–${taken[taken.length - 1]} are all in use by other applications.`,
      'Close whatever is using them, or set gateway.port in openpulse.json to a free port.',
    );
  }

  /** Stop only what this supervisor started. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.clearTimers();
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null) {
      this.setStatus({ state: 'stopped', owned: false, pid: undefined });
      return;
    }
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      child.once('exit', done);
      child.kill();
      // Windows ignores SIGTERM for some runtimes; escalate after a grace period.
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
        resolve();
      }, 4_000).unref?.();
    });
    this.setStatus({ state: 'stopped', owned: false, pid: undefined });
  }

  /** Stop and start again, for the "Restart gateway" command. */
  async restart(): Promise<GatewayStatus> {
    await this.stop();
    this.setStatus({ restarts: this.statusValue.restarts + 1 });
    return this.start();
  }

  // -----------------------------------------------------------------------------------------------

  private async spawnGateway(): Promise<GatewayStatus> {
    this.setStatus({ state: 'starting', owned: true, error: undefined, hint: undefined });

    const child = this.spawnFn(this.options.nodeBin, [this.options.entry], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        OPENPULSE_PORT: String(this.activePort),
        ...(this.options.stateDir ? { OPENPULSE_STATE_DIR: this.options.stateDir } : {}),
        ...this.options.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;

    child.stdout?.on('data', (chunk: Buffer) => this.onLog(chunk.toString(), 'stdout'));
    child.stderr?.on('data', (chunk: Buffer) => this.onLog(chunk.toString(), 'stderr'));
    child.on('error', (error) => {
      this.fail(`Could not start the gateway: ${error.message}`, 'Check the diagnostics log.');
    });
    child.on('exit', (code, signal) => this.onExit(code, signal));

    this.setStatus({ pid: child.pid ?? undefined, startedAt: this.now() });

    const deadline = this.now() + (this.options.startTimeoutMs ?? 30_000);
    while (this.now() < deadline) {
      if (this.stopping) return this.statusValue;
      if (child.exitCode !== null) {
        return this.fail(
          `The gateway exited during startup (code ${child.exitCode}).`,
          'Open diagnostics to see what it printed.',
        );
      }
      const probe = await this.probeHealth();
      if (probe.ok) {
        this.setStatus({
          state: 'ready',
          owned: true,
          url: this.url,
          port: this.activePort,
          ...(probe.version !== undefined && { version: probe.version }),
          lastHealthyAt: this.now(),
        });
        this.watchHealth();
        return this.statusValue;
      }
      await delay(300);
    }
    return this.fail(
      'The gateway did not become healthy in time.',
      'Open diagnostics to see what it printed, then try restarting it.',
    );
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.child = undefined;
    this.clearTimers();
    if (this.stopping) {
      this.setStatus({ state: 'stopped', owned: false, pid: undefined });
      return;
    }
    const attempt = this.statusValue.restarts;
    const max = this.options.maxRestarts ?? 5;
    if (attempt >= max) {
      void this.fail(
        `The gateway keeps stopping (last exit: ${signal ?? code ?? 'unknown'}).`,
        'Open diagnostics, fix the underlying error, then restart the gateway.',
      );
      return;
    }
    const wait = RESTART_BACKOFF_MS[Math.min(attempt, RESTART_BACKOFF_MS.length - 1)] ?? 5_000;
    this.setStatus({
      state: 'restarting',
      pid: undefined,
      restarts: attempt + 1,
      error: `The gateway stopped unexpectedly (${signal ?? code ?? 'unknown'}). Restarting…`,
    });
    this.restartTimer = setTimeout(() => void this.spawnGateway(), wait);
    this.restartTimer.unref?.();
  }

  private watchHealth(): void {
    this.clearTimers();
    const interval = this.options.healthIntervalMs ?? 10_000;
    this.healthTimer = setInterval(() => {
      void this.probeHealth().then((probe) => {
        if (probe.ok) {
          this.setStatus({ lastHealthyAt: this.now() });
          return;
        }
        // An attached gateway that goes away is not ours to restart.
        if (!this.statusValue.owned) {
          this.setStatus({
            state: 'failed',
            error: 'The gateway this window attached to is no longer responding.',
            hint: 'Start it again, or restart OpenPulse to launch its own gateway.',
          });
          this.clearTimers();
        }
      });
    }, interval);
    this.healthTimer.unref?.();
  }

  private async probeHealth(): Promise<{ ok: boolean; version?: string }> {
    const probe = await probePort(this.activePort, {
      fetchFn: this.fetchFn,
      ...(this.options.connectFn && { connectFn: this.options.connectFn }),
    });
    return probe.occupant === 'openpulse'
      ? { ok: true, ...(probe.version !== undefined && { version: probe.version }) }
      : { ok: false };
  }

  private fail(error: string, hint: string): GatewayStatus {
    this.clearTimers();
    this.setStatus({ state: 'failed', error, hint, pid: undefined });
    return this.statusValue;
  }

  private onLog(chunk: string, stream: 'stdout' | 'stderr'): void {
    for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
      this.recentLogs.push(line);
      if (this.recentLogs.length > 500) this.recentLogs.shift();
      this.options.onLog?.(line, stream);
      this.emit('log', { line, stream });
    }
  }

  private setStatus(patch: Partial<GatewayStatus>): void {
    this.statusValue = { ...this.statusValue, ...patch };
    this.emit('status', this.statusValue);
  }

  private clearTimers(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.healthTimer = undefined;
    this.restartTimer = undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
