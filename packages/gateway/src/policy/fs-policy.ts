import os from 'node:os';
import path from 'node:path';
import { isWithin } from '../tools/paths.js';

export type SecurityMode = 'read-only' | 'balanced' | 'custom';

export interface FsPolicyInput {
  mode: SecurityMode;
  /** Directories the agent may read from. */
  readRoots: string[];
  /** Directories the agent may write to (always a subset of what it may read). */
  writeRoots: string[];
  /** Glob-ish patterns refused everywhere, checked before any root. */
  denyPatterns: string[];
}

export interface FsDecision {
  allowed: boolean;
  /** Operator-facing explanation, suitable to hand straight to the model. */
  reason?: string;
}

/** Paths that are never readable: other people's secrets and the gateway's own keys. */
export const DEFAULT_DENY_PATTERNS = [
  '**/.ssh/**',
  '**/.aws/credentials',
  '**/.aws/config',
  '**/.gnupg/**',
  '**/.openpulse/credentials/**',
  '**/.openpulse/identity/**',
  '**/.openpulse/devices/**',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/*.pem',
  '**/*.pfx',
  '**/.npmrc',
  '**/.git-credentials',
];

/**
 * What the agent may touch on this machine.
 *
 * The rule is simple and enforced, not advisory: a path must sit inside a declared root, and must
 * not match a deny pattern. Writes additionally require a write root, and in read-only mode there
 * are none. This runs in the tool layer, so it covers the model, skills and anything else that goes
 * through `read`, `write` and `edit`.
 */
export class FsPolicy {
  readonly mode: SecurityMode;
  readonly readRoots: string[];
  readonly writeRoots: string[];
  readonly denyPatterns: string[];

  constructor(input: FsPolicyInput) {
    this.mode = input.mode;
    this.denyPatterns = input.denyPatterns;
    this.readRoots = dedupe(input.readRoots.map(expand));
    this.writeRoots = input.mode === 'read-only' ? [] : dedupe(input.writeRoots.map(expand));
  }

  canRead(target: string): FsDecision {
    const file = path.resolve(target);
    const denied = this.matchDeny(file);
    if (denied) {
      return { allowed: false, reason: `"${file}" is on the always-denied list (${denied}).` };
    }
    if (!this.readRoots.some((root) => isWithin(root, file))) {
      return {
        allowed: false,
        reason: `"${file}" is outside the allowed workspace. Readable roots: ${this.readRoots.join(', ') || '(none)'}.`,
      };
    }
    return { allowed: true };
  }

  canWrite(target: string): FsDecision {
    const file = path.resolve(target);
    const read = this.canRead(file);
    if (!read.allowed) return read;
    if (this.mode === 'read-only') {
      return {
        allowed: false,
        reason: 'The agent is in read-only mode, so it cannot change files.',
      };
    }
    if (!this.writeRoots.some((root) => isWithin(root, file))) {
      return {
        allowed: false,
        reason: `"${file}" is outside the writable workspace. Writable roots: ${this.writeRoots.join(', ') || '(none)'}.`,
      };
    }
    return { allowed: true };
  }

  /** The first deny pattern a path matches, if any. */
  private matchDeny(file: string): string | undefined {
    const normalised = file.replace(/\\/g, '/');
    return this.denyPatterns.find((pattern) => globMatch(pattern, normalised));
  }

  describe(): FsPolicyInput {
    return {
      mode: this.mode,
      readRoots: [...this.readRoots],
      writeRoots: [...this.writeRoots],
      denyPatterns: [...this.denyPatterns],
    };
  }
}

/**
 * Case-insensitive glob supporting `*` (within one path segment), `**` (any depth) and `?`.
 *
 * Translated in a single pass: rewriting the pattern with successive replaces would mangle the
 * regex syntax produced by earlier steps.
 */
export function globMatch(pattern: string, target: string): boolean {
  const source = pattern.replace(/\\/g, '/');
  let expression = '';
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!;
    if (char === '*') {
      if (source[i + 1] === '*') {
        if (source[i + 2] === '/') {
          expression += '(?:.*/)?'; // any number of leading directories, including none
          i += 2;
        } else {
          expression += '.*';
          i += 1;
        }
      } else {
        expression += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      expression += '[^/]';
      continue;
    }
    expression += /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`^${expression}$`, 'i').test(target);
}

function expand(target: string): string {
  const trimmed = target.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.resolve(os.homedir(), trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = process.platform === 'win32' ? value.toLowerCase() : value;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}
