import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface RunProcessOptions {
  file: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Written to the child's stdin, which is then closed. */
  input?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Stop buffering a stream after this many bytes (the process keeps running). */
  maxBufferBytes?: number;
  /** Windows only: pass args unquoted (needed for cmd.exe). */
  windowsVerbatimArguments?: boolean;
}

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  /** Set when the process could not be started at all (e.g. executable not found). */
  spawnError?: string;
  durationMs: number;
}

/** Spawn a process without a shell, capture its output and kill its whole tree on timeout/abort. */
export function runProcess(options: RunProcessOptions): Promise<ProcessResult> {
  const started = Date.now();
  const maxBytes = options.maxBufferBytes ?? 2 * 1024 * 1024;

  return new Promise((resolve) => {
    const child = spawn(options.file, options.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      windowsVerbatimArguments: options.windowsVerbatimArguments ?? false,
      // Own process group on POSIX so the whole tree can be killed at once.
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdout = new BoundedBuffer(maxBytes);
    const stderr = new BoundedBuffer(maxBytes);
    let timedOut = false;
    let aborted = false;
    let settled = false;

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on('error', () => undefined); // child may exit before reading stdin
    child.stdin.end(options.input ?? '');

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, options.timeoutMs);

    const onAbort = () => {
      aborted = true;
      killTree(child.pid);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (exitCode: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        timedOut,
        aborted,
        durationMs: Date.now() - started,
        ...(spawnError !== undefined && { spawnError }),
      });
    };

    child.on('error', (error) => finish(null, error.message));
    child.on('close', (code) => finish(code));
  });
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
    // Already exited.
  }
}

class BoundedBuffer {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  private dropped = 0;

  constructor(private readonly max: number) {}

  push(chunk: Buffer): void {
    const room = this.max - this.size;
    if (room <= 0) {
      this.dropped += chunk.length;
      return;
    }
    const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
    this.chunks.push(kept);
    this.size += kept.length;
    this.dropped += chunk.length - kept.length;
  }

  toString(): string {
    const text = Buffer.concat(this.chunks).toString('utf8');
    return this.dropped > 0 ? `${text}\n[… ${this.dropped} more bytes not captured]` : text;
  }
}

/** Keep the head and tail of long output so the model sees both the start and the final errors. */
export function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.4);
  const tail = maxChars - head;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n\n[… ${omitted} characters omitted …]\n\n${text.slice(-tail)}`;
}

export interface ShellInvocation {
  file: string;
  args: string[];
  /** Human-readable shell name, used in the tool description so the model writes the right syntax. */
  name: string;
  windowsVerbatimArguments?: boolean;
}

/**
 * Work out how to run a command string through the user's shell.
 * Defaults: Windows PowerShell on Windows, bash (or sh) elsewhere.
 */
export function shellInvocation(command: string, shellPath?: string): ShellInvocation {
  const shell =
    shellPath ??
    (process.platform === 'win32'
      ? 'powershell.exe'
      : fs.existsSync('/bin/bash')
        ? '/bin/bash'
        : '/bin/sh');
  const base = path
    .basename(shell)
    .toLowerCase()
    .replace(/\.exe$/, '');

  if (base === 'powershell' || base === 'pwsh') {
    // PowerShell writes redirected output in the OEM code page by default; force UTF-8.
    const prelude =
      '$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ';
    return {
      file: shell,
      args: ['-NoProfile', '-NonInteractive', '-Command', prelude + command],
      name: base === 'pwsh' ? 'PowerShell 7 (pwsh)' : 'Windows PowerShell',
    };
  }
  if (base === 'cmd') {
    return {
      file: shell,
      args: ['/d', '/s', '/c', `"${command}"`],
      name: 'cmd.exe',
      windowsVerbatimArguments: true,
    };
  }
  return { file: shell, args: ['-c', command], name: base };
}
