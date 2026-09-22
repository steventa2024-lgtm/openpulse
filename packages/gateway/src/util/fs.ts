import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Read a UTF-8 file, returning `fallback` when it doesn't exist. */
export async function readTextOr(p: string, fallback: string): Promise<string> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return fallback;
    throw error;
  }
}

/**
 * Write a file atomically: write to a sibling temp file, then rename over the target, so readers
 * never observe a half-written file and a crash mid-write can't truncate it.
 */
export async function writeFileAtomic(
  p: string,
  content: string,
  options: { mode?: number } = {},
): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, content, { encoding: 'utf8', mode: options.mode });
    await renameWithRetry(tmp, p);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

/** Create the file with `content` only if it doesn't exist yet. Returns true if it was created. */
export async function writeFileIfMissing(p: string, content: string): Promise<boolean> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  try {
    await fs.writeFile(p, content, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

export function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/**
 * On Windows, rename can fail transiently with EPERM/EBUSY when another process (antivirus,
 * indexer, an editor) briefly holds the target open. Retry a few times before giving up.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt));
    }
  }
}

/**
 * Serialises async work per key (e.g. per file path) so read-modify-write cycles on the same file
 * never interleave. Different keys run concurrently.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}
