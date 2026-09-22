import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import JSON5 from 'json5';
import { readTextOr, writeFileAtomic } from '../util/fs.js';
import { ConfigSchema, type OpenPulseConfig } from './schema.js';

export interface ConfigSnapshot {
  path: string;
  exists: boolean;
  /** Raw JSON5 text as authored on disk. */
  raw: string;
  /** Hash of `raw`; pass back as `baseHash` on writes to detect concurrent edits. */
  hash: string;
  valid: boolean;
  issues: ConfigIssue[];
  /** Parsed + defaulted config (defaults only when invalid). */
  config: OpenPulseConfig;
}

export interface ConfigIssue {
  path: string;
  message: string;
}

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly code: 'INVALID_CONFIG' | 'CONFLICT' | 'PARSE_ERROR',
    readonly issues: ConfigIssue[] = [],
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

const DEFAULTS = ConfigSchema.parse({});

/**
 * Owns openpulse.json. Reads JSON5, validates strictly (unknown keys are errors), substitutes
 * `${ENV}` references, and guards writes with a base hash. Watches the file for external edits.
 */
export class ConfigStore extends EventEmitter<{ change: [ConfigSnapshot, ConfigSnapshot] }> {
  private snapshot: ConfigSnapshot | undefined;
  private watcher: fs.FSWatcher | undefined;
  private watchTimer: NodeJS.Timeout | undefined;

  constructor(
    readonly path: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    super();
  }

  async load(): Promise<ConfigSnapshot> {
    const exists = fs.existsSync(this.path);
    const raw = exists ? await readTextOr(this.path, '') : '';
    this.snapshot = this.evaluate(raw, exists);
    return this.snapshot;
  }

  get(): ConfigSnapshot {
    if (!this.snapshot) throw new Error('ConfigStore.load() has not been called');
    return this.snapshot;
  }

  /** The effective config (defaults if the file is invalid). */
  get config(): OpenPulseConfig {
    return this.get().config;
  }

  /** Replace the whole file with `raw` (validated). */
  async set(raw: string, baseHash?: string): Promise<ConfigSnapshot> {
    this.checkBase(baseHash);
    const next = this.evaluate(raw, true);
    if (!next.valid) {
      throw new ConfigError('Config is invalid', 'INVALID_CONFIG', next.issues);
    }
    await this.write(raw);
    return this.replace(next);
  }

  /**
   * JSON merge patch (RFC 7386): objects merge recursively, `null` deletes, arrays replace.
   * `patch` may be a JSON5 string or an object.
   */
  async patch(patch: string | Record<string, unknown>, baseHash?: string): Promise<ConfigSnapshot> {
    this.checkBase(baseHash);
    const current = this.get();
    const base = current.raw.trim() ? JSON5.parse<Record<string, unknown>>(current.raw) : {};
    const delta = typeof patch === 'string' ? JSON5.parse<Record<string, unknown>>(patch) : patch;
    const merged = mergePatch(base, delta) as Record<string, unknown>;
    merged.meta = {
      ...(merged.meta ?? {}),
      lastTouchedAt: new Date().toISOString(),
    };
    const raw = `${JSON.stringify(merged, null, 2)}\n`;
    return this.set(raw);
  }

  /** Ensure a config file exists with a generated gateway token (first run / onboarding). */
  async ensure(initial: Record<string, unknown> = {}): Promise<ConfigSnapshot> {
    const snap = await this.load();
    if (snap.exists) return snap;
    const seed = mergePatch(
      { gateway: { auth: { mode: 'token', token: randomBytes(24).toString('hex') } } },
      initial,
    );
    await this.write(`${JSON.stringify(seed, null, 2)}\n`);
    return this.load();
  }

  watch(): void {
    if (this.watcher) return;
    try {
      this.watcher = fs.watch(this.path, () => {
        clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => void this.reloadFromDisk(), 300);
      });
      this.watcher.on('error', () => undefined);
    } catch {
      // File may not exist yet; writes through this store still emit changes.
    }
  }

  unwatch(): void {
    clearTimeout(this.watchTimer);
    this.watcher?.close();
    this.watcher = undefined;
  }

  private async reloadFromDisk(): Promise<void> {
    const prev = this.snapshot;
    const raw = await readTextOr(this.path, '');
    if (prev && raw === prev.raw) return;
    const next = this.evaluate(raw, true);
    this.replace(next);
  }

  private replace(next: ConfigSnapshot): ConfigSnapshot {
    const prev = this.snapshot ?? next;
    this.snapshot = next;
    if (prev.hash !== next.hash) this.emit('change', next, prev);
    return next;
  }

  private checkBase(baseHash: string | undefined): void {
    if (baseHash !== undefined && this.snapshot && baseHash !== this.snapshot.hash) {
      throw new ConfigError(
        'Config changed since it was loaded (base hash mismatch). Reload and try again.',
        'CONFLICT',
      );
    }
  }

  private async write(raw: string): Promise<void> {
    await writeFileAtomic(this.path, raw, { mode: 0o600 });
  }

  private evaluate(raw: string, exists: boolean): ConfigSnapshot {
    const hash = createHash('sha256').update(raw).digest('hex');
    const base = { path: this.path, exists, raw, hash };
    if (raw.trim() === '') return { ...base, valid: true, issues: [], config: DEFAULTS };

    let parsed: unknown;
    try {
      parsed = JSON5.parse(raw);
    } catch (error) {
      return {
        ...base,
        valid: false,
        issues: [{ path: '', message: `JSON5 parse error: ${(error as Error).message}` }],
        config: DEFAULTS,
      };
    }

    let substituted: unknown;
    try {
      substituted = substituteEnv(parsed, this.env);
    } catch (error) {
      return {
        ...base,
        valid: false,
        issues: [{ path: '', message: (error as Error).message }],
        config: DEFAULTS,
      };
    }

    const result = ConfigSchema.safeParse(substituted);
    if (!result.success) {
      return {
        ...base,
        valid: false,
        issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        config: DEFAULTS,
      };
    }
    return { ...base, valid: true, issues: [], config: result.data };
  }
}

export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isObject(patch)) return patch;
  const out: Record<string, unknown> = isObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else out[key] = mergePatch(out[key], value);
  }
  return out;
}

/** Replace `${VAR}` in string values; `$${VAR}` escapes. Missing vars are errors. */
function substituteEnv(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$?\$\{([A-Z_][A-Z0-9_]*)\}/g, (all, name: string) => {
      if (all.startsWith('$$')) return all.slice(1);
      const v = env[name];
      if (v === undefined || v === '')
        throw new Error(`Missing environment variable \${${name}} referenced in config`);
      return v;
    });
  }
  if (Array.isArray(value)) return value.map((v) => substituteEnv(v, env));
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteEnv(v, env)]));
  }
  return value;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Get a nested config value by dot path (for `openpulse config get`). */
export function getPath(obj: unknown, dotted: string): unknown {
  return dotted
    .split('.')
    .filter(Boolean)
    .reduce<unknown>((o, k) => (isObject(o) ? o[k] : undefined), obj);
}

/** Build a merge-patch object that sets `dotted` to `value` (null unsets). */
export function patchForPath(dotted: string, value: unknown): Record<string, unknown> {
  const keys = dotted.split('.').filter(Boolean);
  const root: Record<string, unknown> = {};
  let node = root;
  keys.forEach((k, i) => {
    if (i === keys.length - 1) node[k] = value;
    else {
      node[k] = {};
      node = node[k] as Record<string, unknown>;
    }
  });
  return root;
}
