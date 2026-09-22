import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** One JSONL line in logs/openpulse-YYYY-MM-DD.log. */
export interface LogRecord {
  time: string;
  level: LogLevel;
  subsystem: string;
  msg: string;
  [key: string]: unknown;
}

export interface Logger {
  trace(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(subsystem: string): Logger;
}

export interface LogSinkOptions {
  dir?: string;
  level?: LogLevel;
  /** Mirror records to the console (foreground `openpulse gateway`). */
  console?: (record: LogRecord) => void;
}

const SECRET_KEY = /(token$|secret|password|passwd|api[-_]?key|authorization|credential)/i;

/**
 * Structured gateway log: JSONL files per day (tailed by `logs.tail` / the Logs tab), live
 * subscribers, and optional console mirroring.
 */
export class LogSink extends EventEmitter<{ record: [LogRecord] }> {
  private level: LogLevel;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly options: LogSinkOptions = {}) {
    super();
    this.level = options.level ?? 'info';
    this.setMaxListeners(100);
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  get dir(): string | undefined {
    return this.options.dir;
  }

  /** Path of today's log file. */
  currentFile(now = new Date()): string | undefined {
    return this.options.dir
      ? path.join(this.options.dir, `openpulse-${localDate(now)}.log`)
      : undefined;
  }

  write(level: LogLevel, subsystem: string, msg: string, meta: Record<string, unknown> = {}): void {
    if (LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(this.level)) return;
    const record: LogRecord = {
      time: new Date().toISOString(),
      level,
      subsystem,
      msg,
      ...redact(meta),
    };
    this.emit('record', record);
    this.options.console?.(record);
    const file = this.currentFile();
    if (!file) return;
    const line = `${JSON.stringify(record)}\n`;
    this.chain = this.chain
      .then(async () => {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.appendFile(file, line, 'utf8');
      })
      .catch(() => undefined);
  }

  logger(subsystem: string): Logger {
    const make = (sub: string): Logger => ({
      trace: (m, d) => this.write('trace', sub, m, d),
      debug: (m, d) => this.write('debug', sub, m, d),
      info: (m, d) => this.write('info', sub, m, d),
      warn: (m, d) => this.write('warn', sub, m, d),
      error: (m, d) => this.write('error', sub, m, d),
      child: (s) => make(`${sub}/${s}`),
    });
    return make(subsystem);
  }

  flush(): Promise<void> {
    return this.chain;
  }

  /**
   * Tail the current log file. `cursor` is a byte offset from a previous call; without one the
   * last `maxBytes` are returned. A cursor beyond the file size (rotation) resets to the start.
   */
  async tail(
    params: { cursor?: number; limit?: number; maxBytes?: number } = {},
  ): Promise<LogTail> {
    await this.flush();
    const file = this.currentFile();
    const limit = Math.min(Math.max(params.limit ?? 500, 1), 5000);
    const maxBytes = Math.min(Math.max(params.maxBytes ?? 250_000, 1024), 5_000_000);
    if (!file || !fs.existsSync(file)) {
      return { file: file ?? '', cursor: 0, size: 0, lines: [], truncated: false, reset: false };
    }
    const size = (await fsp.stat(file)).size;
    let start = params.cursor ?? Math.max(0, size - maxBytes);
    let reset = false;
    if (start > size) {
      start = 0;
      reset = true;
    }
    let truncated = false;
    if (size - start > maxBytes) {
      start = size - maxBytes;
      truncated = true;
    }
    const handle = await fsp.open(file, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      await handle.read(buf, 0, buf.length, start);
      let text = buf.toString('utf8');
      // Drop a partial first line when we started mid-file.
      if (start > 0 && params.cursor === undefined) text = text.slice(text.indexOf('\n') + 1);
      let lines = text.split('\n').filter((l) => l.trim() !== '');
      if (lines.length > limit) {
        lines = lines.slice(-limit);
        truncated = true;
      }
      return { file, cursor: size, size, lines, truncated, reset };
    } finally {
      await handle.close();
    }
  }
}

export interface LogTail {
  file: string;
  cursor: number;
  size: number;
  lines: string[];
  truncated: boolean;
  reset: boolean;
}

export const silentLogger: Logger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

function redact(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined) continue;
    if (SECRET_KEY.test(k)) out[k] = '[redacted]';
    else if (typeof v === 'string' && v.length > 4000) out[k] = `${v.slice(0, 4000)}…`;
    else out[k] = v;
  }
  return out;
}

function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
