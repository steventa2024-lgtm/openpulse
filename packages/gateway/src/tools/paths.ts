import os from 'node:os';
import path from 'node:path';

/** Resolve a user/model-supplied path: expands `~`, resolves relative paths against `cwd`. */
export function resolveUserPath(p: string, cwd: string): string {
  const trimmed = p.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return path.resolve(cwd, trimmed);
}

/** True if `child` is `parent` or inside it (case-insensitive on Windows). */
export function isWithin(parent: string, child: string): boolean {
  const norm = (p: string) => {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const rel = path.relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
