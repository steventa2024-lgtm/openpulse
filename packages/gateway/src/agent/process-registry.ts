import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { shellInvocation } from '../tools/process.js';

export interface ProcessSession {
  id: string;
  agentId: string;
  command: string;
  cwd: string;
  pid?: number;
  startedAt: number;
  endedAt?: number;
  exitCode: number | null;
  status: 'running' | 'exited' | 'killed' | 'timeout' | 'failed';
  /** Combined stdout+stderr (bounded). */
  output: string;
  /** Offset into `output` already returned by poll. */
  pollOffset: number;
  child?: ChildProcessWithoutNullStreams;
  timer?: NodeJS.Timeout;
  waiters: (() => void)[];
}

const MAX_OUTPUT = 1_000_000;

/** Tracks exec processes (foreground and backgrounded) so `process` can poll/log/write/kill them. */
export class ProcessRegistry {
  private readonly sessions = new Map<string, ProcessSession>();

  start(opts: {
    agentId: string;
    command: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    shellPath?: string;
  }): ProcessSession {
    const inv = shellInvocation(opts.command, opts.shellPath);
    const session: ProcessSession = {
      id: randomBytes(3).toString('hex'),
      agentId: opts.agentId,
      command: opts.command,
      cwd: opts.cwd,
      startedAt: Date.now(),
      exitCode: null,
      status: 'running',
      output: '',
      pollOffset: 0,
      waiters: [],
    };
    this.sessions.set(session.id, session);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(inv.file, inv.args, {
        cwd: opts.cwd,
        env: opts.env,
        windowsHide: true,
        windowsVerbatimArguments: inv.windowsVerbatimArguments ?? false,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.finish(session, 'failed', null, `Failed to start: ${(error as Error).message}`);
      return session;
    }
    session.child = child;
    session.pid = child.pid;
    const onData = (chunk: Buffer) => {
      session.output += chunk.toString('utf8').replace(/\r\n?/g, '\n');
      if (session.output.length > MAX_OUTPUT) session.output = session.output.slice(-MAX_OUTPUT);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.stdin.on('error', () => undefined);
    child.on('error', (e) => this.finish(session, 'failed', null, `\n[spawn error] ${e.message}`));
    child.on('close', (code) =>
      this.finish(session, session.status === 'running' ? 'exited' : session.status, code),
    );
    session.timer = setTimeout(() => {
      session.status = 'timeout';
      killTree(child.pid);
    }, opts.timeoutMs);
    return session;
  }

  /** Resolve when the process exits or `ms` elapses (whichever first). Returns true if exited. */
  waitFor(session: ProcessSession, ms: number, signal?: AbortSignal): Promise<boolean> {
    if (session.status !== 'running') return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        signal?.removeEventListener('abort', abort);
        resolve(session.status !== 'running');
      };
      const abort = () => {
        this.kill(session.id);
        done();
      };
      const t = setTimeout(done, ms);
      session.waiters.push(done);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  get(id: string, agentId?: string): ProcessSession | undefined {
    const s = this.sessions.get(id);
    return s && (!agentId || s.agentId === agentId) ? s : undefined;
  }

  list(agentId?: string): ProcessSession[] {
    return [...this.sessions.values()].filter((s) => !agentId || s.agentId === agentId);
  }

  write(id: string, data: string): boolean {
    const s = this.sessions.get(id);
    if (!s?.child || s.status !== 'running') return false;
    s.child.stdin.write(data);
    return true;
  }

  kill(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s || s.status !== 'running') return false;
    s.status = 'killed';
    killTree(s.pid);
    return true;
  }

  remove(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.status === 'running') this.kill(id);
    return this.sessions.delete(id);
  }

  killAll(): void {
    for (const s of this.sessions.values()) if (s.status === 'running') this.kill(s.id);
  }

  private finish(
    session: ProcessSession,
    status: ProcessSession['status'],
    code: number | null,
    extra = '',
  ): void {
    if (session.endedAt) return;
    session.status = status;
    session.exitCode = code;
    session.endedAt = Date.now();
    session.output += extra;
    clearTimeout(session.timer);
    for (const w of session.waiters.splice(0)) w();
  }
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // already gone
  }
}
