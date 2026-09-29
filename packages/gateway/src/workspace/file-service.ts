import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FsPolicy } from '../policy/fs-policy.js';
import { isWithin } from '../tools/paths.js';

export const MAX_EDITABLE_BYTES = 8 * 1024 * 1024;

/** Directories that would drown the tree and are never interesting to edit. */
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  '.turbo',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  'build',
  'target',
  '.gradle',
  '.idea',
  '.pnpm-store',
]);

export class FileServiceError extends Error {
  constructor(
    readonly code:
      'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT' | 'TOO_LARGE' | 'BINARY' | 'EXISTS' | 'INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'FileServiceError';
  }
}

export interface TreeEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  updatedAtMs: number;
  /** True when the directory was not expanded because the depth limit was reached. */
  collapsed?: boolean;
}

export interface FileContent {
  path: string;
  content: string;
  /** sha256 of the bytes on disk; hand it back on write to detect outside changes. */
  hash: string;
  size: number;
  updatedAtMs: number;
  truncated: boolean;
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

/**
 * Reads and writes files inside a project.
 *
 * Every path is resolved against the project root and then checked against the agent's filesystem
 * policy, so the editor cannot reach further than the agent can. Writes carry the hash the caller
 * last saw: if the file changed underneath, the write is refused instead of silently winning.
 */
export class FileService {
  constructor(
    readonly root: string,
    private readonly policy: FsPolicy,
  ) {}

  /** Resolve a project-relative path, refusing anything that escapes the root or the policy. */
  resolve(relative: string, intent: 'read' | 'write' = 'read'): string {
    const target = path.resolve(this.root, relative);
    if (!isWithin(this.root, target)) {
      throw new FileServiceError('FORBIDDEN', `"${relative}" is outside the project.`);
    }
    const decision =
      intent === 'write' ? this.policy.canWrite(target) : this.policy.canRead(target);
    if (!decision.allowed)
      throw new FileServiceError('FORBIDDEN', decision.reason ?? 'Not allowed.');
    return target;
  }

  relative(absolute: string): string {
    return path.relative(this.root, absolute).replace(/\\/g, '/');
  }

  async tree(
    options: { dir?: string; depth?: number; includeHidden?: boolean } = {},
  ): Promise<TreeEntry[]> {
    const start = this.resolve(options.dir ?? '.');
    const depth = Math.min(Math.max(options.depth ?? 1, 1), 6);
    const entries: TreeEntry[] = [];
    await this.walk(start, depth, Boolean(options.includeHidden), entries);
    return entries.sort((a, b) =>
      a.type === b.type ? a.path.localeCompare(b.path) : a.type === 'directory' ? -1 : 1,
    );
  }

  private async walk(
    dir: string,
    depth: number,
    includeHidden: boolean,
    out: TreeEntry[],
  ): Promise<void> {
    let children;
    try {
      children = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      if (!includeHidden && child.name.startsWith('.') && child.name !== '.github') continue;
      const absolute = path.join(dir, child.name);
      const isDir = child.isDirectory();
      if (isDir && SKIP_DIRS.has(child.name)) continue;
      if (!this.policy.canRead(absolute).allowed) continue;

      let stat;
      try {
        stat = await fs.stat(absolute);
      } catch {
        continue;
      }
      const entry: TreeEntry = {
        name: child.name,
        path: this.relative(absolute),
        type: isDir ? 'directory' : 'file',
        size: stat.size,
        updatedAtMs: stat.mtimeMs,
      };
      if (isDir && depth <= 1) entry.collapsed = true;
      out.push(entry);
      if (isDir && depth > 1) await this.walk(absolute, depth - 1, includeHidden, out);
    }
  }

  async read(relative: string, options: { maxBytes?: number } = {}): Promise<FileContent> {
    const file = this.resolve(relative);
    const stat = await fs.stat(file).catch(() => {
      throw new FileServiceError('NOT_FOUND', `No such file: ${relative}`);
    });
    if (stat.isDirectory()) throw new FileServiceError('INVALID', `${relative} is a directory.`);

    const limit = options.maxBytes ?? MAX_EDITABLE_BYTES;
    if (stat.size > limit) {
      throw new FileServiceError(
        'TOO_LARGE',
        `${relative} is ${stat.size} bytes; too large to open in the editor.`,
      );
    }
    const buffer = await fs.readFile(file);
    if (buffer.subarray(0, 8000).includes(0)) {
      throw new FileServiceError('BINARY', `${relative} is a binary file.`);
    }
    return {
      path: this.relative(file),
      content: buffer.toString('utf8'),
      hash: hashOf(buffer),
      size: stat.size,
      updatedAtMs: stat.mtimeMs,
      truncated: false,
    };
  }

  /**
   * Write a file. When `baseHash` is given it must match what is on disk, so an edit made in the
   * editor cannot quietly overwrite a change made by the agent, another tool or the developer.
   */
  async write(
    relative: string,
    content: string,
    options: { baseHash?: string; createOnly?: boolean } = {},
  ): Promise<FileContent> {
    const file = this.resolve(relative, 'write');
    const existing = await fs.readFile(file).catch(() => undefined);

    if (options.createOnly && existing)
      throw new FileServiceError('EXISTS', `${relative} already exists.`);
    if (options.baseHash !== undefined) {
      const current = existing ? hashOf(existing) : '';
      if (current !== options.baseHash) {
        throw new FileServiceError(
          'CONFLICT',
          `${relative} changed on disk since it was opened. Reload it and re-apply the change.`,
        );
      }
    }

    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, 'utf8');
    const stat = await fs.stat(file);
    return {
      path: this.relative(file),
      content,
      hash: hashOf(Buffer.from(content, 'utf8')),
      size: stat.size,
      updatedAtMs: stat.mtimeMs,
      truncated: false,
    };
  }

  async createDirectory(relative: string): Promise<void> {
    const dir = this.resolve(relative, 'write');
    await fs.mkdir(dir, { recursive: true });
  }

  async remove(relative: string, options: { recursive?: boolean } = {}): Promise<void> {
    const target = this.resolve(relative, 'write');
    if (path.resolve(target) === path.resolve(this.root)) {
      throw new FileServiceError('FORBIDDEN', 'Refusing to delete the project root.');
    }
    const stat = await fs.stat(target).catch(() => {
      throw new FileServiceError('NOT_FOUND', `No such file: ${relative}`);
    });
    if (stat.isDirectory() && !options.recursive) {
      throw new FileServiceError(
        'INVALID',
        `${relative} is a directory; pass recursive to delete it.`,
      );
    }
    await fs.rm(target, { recursive: Boolean(options.recursive), force: false });
  }

  async rename(from: string, to: string): Promise<void> {
    const source = this.resolve(from, 'write');
    const target = this.resolve(to, 'write');
    if (await exists(target)) throw new FileServiceError('EXISTS', `${to} already exists.`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rename(source, target);
  }

  /** Plain substring search over text files, used by the editor's find-in-project. */
  async search(
    query: string,
    options: { maxResults?: number; maxFileBytes?: number; extensions?: string[] } = {},
  ): Promise<SearchHit[]> {
    if (!query.trim()) return [];
    const maxResults = Math.min(options.maxResults ?? 200, 1000);
    const maxFileBytes = options.maxFileBytes ?? 1024 * 1024;
    const needle = query.toLowerCase();
    const hits: SearchHit[] = [];

    const visit = async (dir: string): Promise<void> => {
      if (hits.length >= maxResults) return;
      let children;
      try {
        children = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const child of children) {
        if (hits.length >= maxResults) return;
        const absolute = path.join(dir, child.name);
        if (child.isDirectory()) {
          if (SKIP_DIRS.has(child.name) || child.name.startsWith('.')) continue;
          await visit(absolute);
          continue;
        }
        if (options.extensions && !options.extensions.includes(path.extname(child.name))) continue;
        if (!this.policy.canRead(absolute).allowed) continue;
        const stat = await fs.stat(absolute).catch(() => undefined);
        if (!stat || stat.size > maxFileBytes) continue;
        const buffer = await fs.readFile(absolute).catch(() => undefined);
        if (!buffer || buffer.subarray(0, 4000).includes(0)) continue;

        const lines = buffer.toString('utf8').split(/\r?\n/);
        for (let i = 0; i < lines.length && hits.length < maxResults; i += 1) {
          const line = lines[i]!;
          if (line.toLowerCase().includes(needle)) {
            hits.push({ path: this.relative(absolute), line: i + 1, text: line.slice(0, 400) });
          }
        }
      }
    };

    await visit(this.root);
    return hits;
  }
}

export function hashOf(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}
