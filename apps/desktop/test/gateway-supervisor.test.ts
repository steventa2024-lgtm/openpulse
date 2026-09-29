import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewaySupervisor, type SupervisorOptions } from '../src/main/gateway-supervisor.js';

/** A child process stand-in: records how it was started and lets tests drive exit/output. */
class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  readonly pid = 4242;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly killed: string[] = [];

  kill(signal?: string): boolean {
    this.killed.push(signal ?? 'SIGTERM');
    return true;
  }

  exit(code: number | null, signal: string | null = null): void {
    this.exitCode = code;
    this.emit('exit', code, signal);
  }
}

interface Harness {
  supervisor: GatewaySupervisor;
  children: FakeChild[];
  spawnArgs: { command: string; args: string[]; env: NodeJS.ProcessEnv }[];
  /** Flip what /health answers on the preferred port. */
  setHealth: (health: 'ok' | 'foreign' | 'down') => void;
  healthCalls: () => number;
}

const supervisors: GatewaySupervisor[] = [];

afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) await supervisor.stop();
  vi.useRealTimers();
});

type HarnessOptions = Partial<SupervisorOptions> & {
  /** Ports that answer HTTP but are not OpenPulse. */
  occupiedPorts?: number[];
  /** Ports that accept a TCP connection and then stay silent. */
  silentPorts?: number[];
};

function harness(
  options: HarnessOptions = {},
  initialHealth: 'ok' | 'foreign' | 'down' = 'down',
): Harness {
  const children: FakeChild[] = [];
  const spawnArgs: Harness['spawnArgs'] = [];
  let health = initialHealth;
  let calls = 0;
  const occupiedPorts = new Set<number>(options.occupiedPorts ?? []);
  const silentPorts = new Set<number>(options.silentPorts ?? []);
  /** Ports where a gateway this harness spawned is answering. */
  const healthyPorts = new Set<number>();

  const fetchFn = (async (input: string | URL | Request) => {
    calls += 1;
    const port = Number(new URL(String(input)).port);
    if (occupiedPorts.has(port)) {
      return new Response(JSON.stringify({ hello: 'some other server' }), { status: 200 });
    }
    if (healthyPorts.has(port)) {
      return new Response(JSON.stringify({ ok: true, version: '0.1.0', uptimeMs: 10 }), {
        status: 200,
      });
    }
    if (port !== 18789 || health === 'down') throw new Error('ECONNREFUSED');
    if (health === 'foreign') {
      return new Response(JSON.stringify({ hello: 'some other server' }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, version: '0.1.0', uptimeMs: 10 }), {
      status: 200,
    });
  }) as unknown as typeof fetch;

  // A socket stand-in: ports in `silentPorts` accept but never speak, like a Windows service.
  const connectFn = ((opts: { port: number }) => {
    const socket = new EventEmitter() as EventEmitter & {
      destroy: () => void;
      setTimeout: (ms: number) => void;
    };
    socket.destroy = () => undefined;
    socket.setTimeout = () => undefined;
    setTimeout(() => {
      if (silentPorts.has(opts.port)) socket.emit('connect');
      else socket.emit('error', new Error('ECONNREFUSED'));
    }, 1);
    return socket;
  }) as unknown as typeof import('node:net').connect;

  const spawnFn = ((command: string, args: string[], spawnOptions: { env: NodeJS.ProcessEnv }) => {
    spawnArgs.push({ command, args, env: spawnOptions.env });
    const child = new FakeChild();
    children.push(child);
    const port = Number(spawnOptions.env.OPENPULSE_PORT);
    // A real gateway becomes healthy on its port shortly after spawning.
    setTimeout(() => {
      if (child.exitCode !== null) return;
      if (health === 'down') health = 'ok';
      healthyPorts.add(port);
    }, 10);
    child.on('exit', () => healthyPorts.delete(port));
    return child;
  }) as unknown as typeof import('node:child_process').spawn;

  const supervisor = new GatewaySupervisor({
    entry: 'C:/app/resources/gateway/main.mjs',
    nodeBin: 'C:/app/OpenPulse.exe',
    port: 18789,
    startTimeoutMs: 2_000,
    healthIntervalMs: 50,
    fetchFn,
    spawnFn,
    connectFn,
    ...options,
  });
  supervisors.push(supervisor);

  return {
    supervisor,
    children,
    spawnArgs,
    setHealth: (next) => {
      health = next;
    },
    healthCalls: () => calls,
  };
}

describe('GatewaySupervisor', () => {
  it('attaches to a gateway that is already running instead of starting a second one', async () => {
    const h = harness({}, 'ok');
    const status = await h.supervisor.start();

    expect(status.state).toBe('attached');
    expect(status.owned).toBe(false);
    expect(status.version).toBe('0.1.0');
    expect(h.spawnArgs).toHaveLength(0);
  });

  it('moves to the next port when another application holds the preferred one', async () => {
    const h = harness({ occupiedPorts: [18789] });
    const status = await h.supervisor.start();

    expect(status.state).toBe('ready');
    expect(status.port).toBe(18790);
    expect(status.url).toBe('http://127.0.0.1:18790');
    expect(h.spawnArgs[0]!.env.OPENPULSE_PORT).toBe('18790');
  });

  it('treats a port that accepts but never answers as taken', async () => {
    // Windows services do this: the TCP connect succeeds, the HTTP request never returns.
    const h = harness({ silentPorts: [18789, 18790] });
    const status = await h.supervisor.start();

    expect(status.state).toBe('ready');
    expect(status.port).toBe(18791);
  });

  it('explains itself when every candidate port is taken', async () => {
    const h = harness({ occupiedPorts: [18789, 18790, 18791], portFallbacks: 2 });
    const status = await h.supervisor.start();

    expect(status.state).toBe('failed');
    expect(status.error).toContain('all in use by other applications');
    expect(status.hint).toContain('gateway.port');
    expect(h.spawnArgs).toHaveLength(0);
  });

  it('starts its own gateway with the Electron binary and no Node requirement', async () => {
    const h = harness();
    const status = await h.supervisor.start();

    expect(status.state).toBe('ready');
    expect(status.owned).toBe(true);
    expect(status.pid).toBe(4242);
    const spawn = h.spawnArgs[0]!;
    expect(spawn.command).toBe('C:/app/OpenPulse.exe');
    expect(spawn.args).toEqual(['C:/app/resources/gateway/main.mjs']);
    expect(spawn.env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(spawn.env.OPENPULSE_PORT).toBe('18789');
  });

  it('passes the packaged resource locations to the gateway', async () => {
    const h = harness({
      env: {
        OPENPULSE_CONTROL_UI_DIR: 'C:/app/resources/dashboard',
        OPENPULSE_BUNDLED_SKILLS_DIR: 'C:/app/resources/skills',
      },
      stateDir: 'C:/Users/dev/.openpulse',
    });
    await h.supervisor.start();

    const env = h.spawnArgs[0]!.env;
    expect(env.OPENPULSE_CONTROL_UI_DIR).toBe('C:/app/resources/dashboard');
    expect(env.OPENPULSE_BUNDLED_SKILLS_DIR).toBe('C:/app/resources/skills');
    expect(env.OPENPULSE_STATE_DIR).toBe('C:/Users/dev/.openpulse');
  });

  it('reports a gateway that dies during startup', async () => {
    const h = harness();
    const started = h.supervisor.start();
    await vi.waitFor(() => expect(h.children).toHaveLength(1));
    h.setHealth('down');
    h.children[0]!.exit(1);

    const status = await started;
    expect(status.state).toBe('failed');
    expect(status.error).toContain('exited during startup');
  });

  it('restarts a gateway it owns after a crash', async () => {
    const h = harness();
    await h.supervisor.start();
    expect(h.supervisor.status.state).toBe('ready');

    h.children[0]!.exit(null, 'SIGSEGV');
    expect(h.supervisor.status.state).toBe('restarting');
    expect(h.supervisor.status.restarts).toBe(1);

    await vi.waitFor(() => expect(h.supervisor.status.state).toBe('ready'), { timeout: 5_000 });
    expect(h.spawnArgs).toHaveLength(2);
  });

  it('gives up after repeated crashes and explains what to do', async () => {
    const h = harness({ maxRestarts: 1 });
    await h.supervisor.start();

    h.children[0]!.exit(1);
    await vi.waitFor(() => expect(h.children).toHaveLength(2), { timeout: 5_000 });
    h.children[1]!.exit(1);

    await vi.waitFor(() => expect(h.supervisor.status.state).toBe('failed'), { timeout: 5_000 });
    expect(h.supervisor.status.error).toContain('keeps stopping');
    expect(h.supervisor.status.hint).toContain('diagnostics');
  });

  it('stops only the process it started', async () => {
    const attached = harness({}, 'ok');
    await attached.supervisor.start();
    await attached.supervisor.stop();
    expect(attached.children).toHaveLength(0);

    const owned = harness();
    await owned.supervisor.start();
    const child = owned.children[0]!;
    const stopping = owned.supervisor.stop();
    child.exit(0);
    await stopping;
    expect(child.killed.length).toBeGreaterThan(0);
    expect(owned.supervisor.status.state).toBe('stopped');
  });

  it('does not restart after a deliberate stop', async () => {
    const h = harness();
    await h.supervisor.start();
    const child = h.children[0]!;
    const stopping = h.supervisor.stop();
    child.exit(0);
    await stopping;

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.spawnArgs).toHaveLength(1);
    expect(h.supervisor.status.state).toBe('stopped');
  });

  it('keeps the gateway output for diagnostics', async () => {
    const h = harness();
    await h.supervisor.start();
    h.children[0]!.stdout.emit(
      'data',
      Buffer.from('gateway listening on 127.0.0.1:18789\nrun done\n'),
    );
    h.children[0]!.stderr.emit('data', Buffer.from('a warning\n'));

    expect(h.supervisor.logTail()).toEqual([
      'gateway listening on 127.0.0.1:18789',
      'run done',
      'a warning',
    ]);
  });

  it('notices when an attached gateway disappears, and does not try to restart it', async () => {
    const h = harness({}, 'ok');
    await h.supervisor.start();
    h.setHealth('down');

    await vi.waitFor(() => expect(h.supervisor.status.state).toBe('failed'), { timeout: 5_000 });
    expect(h.supervisor.status.error).toContain('no longer responding');
    expect(h.spawnArgs).toHaveLength(0);
  });
});
