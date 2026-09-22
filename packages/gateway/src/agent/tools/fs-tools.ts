import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { isNotFound } from '../../util/fs.js';
import { clip, defineTool, fail, ok } from './types.js';

const MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_LINES = 2000;
const MAX_LINE = 2000;

export function resolvePath(p: string, cwd: string): string {
  const t = p.trim();
  if (t === '~') return os.homedir();
  if (t.startsWith('~/') || t.startsWith('~\\')) return path.join(os.homedir(), t.slice(2));
  return path.resolve(cwd, t);
}

export const readTool = defineTool({
  name: 'read',
  description:
    'Read a file (text) or list a directory. Relative paths resolve against the workspace. Use offset/limit (line numbers, 1-based) to page through large files.',
  input: z.object({
    path: z.string().min(1),
    offset: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).max(20_000).optional(),
  }),
  summarize: (i) => `read ${i.path}${i.offset ? `:${i.offset}` : ''}`,
  async execute(input, ctx) {
    const file = resolvePath(input.path, ctx.workspace);
    let stat;
    try {
      stat = await fs.stat(file);
    } catch (error) {
      if (isNotFound(error)) return fail(`File not found: ${file}`);
      throw error;
    }
    if (stat.isDirectory()) {
      const entries = await fs.readdir(file, { withFileTypes: true });
      const names = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
      return ok(
        `${file}/\n${names.slice(0, 1000).join('\n')}${names.length > 1000 ? `\n… ${names.length - 1000} more` : ''}`,
      );
    }
    if (stat.size > MAX_BYTES)
      return fail(`${file} is too large (${stat.size} bytes); use exec to inspect part of it.`);
    const buf = await fs.readFile(file);
    if (buf.subarray(0, 8000).includes(0))
      return fail(`${file} is a binary file (${stat.size} bytes).`);
    const lines = buf.toString('utf8').split(/\r?\n/);
    const start = (input.offset ?? 1) - 1;
    const end = Math.min(lines.length, start + (input.limit ?? DEFAULT_LINES));
    const body = lines
      .slice(start, end)
      .map((l) => (l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)}…` : l))
      .join('\n');
    const more =
      end < lines.length
        ? `\n\n[${lines.length - end} more lines — continue with offset=${end + 1}]`
        : '';
    return ok(clip(body + more, 100_000));
  },
});

export const writeTool = defineTool({
  name: 'write',
  description: 'Create or overwrite a file with the given content. Parent directories are created.',
  input: z.object({ path: z.string().min(1), content: z.string() }),
  summarize: (i) => `write ${i.path} (${Buffer.byteLength(i.content)} bytes)`,
  async execute(input, ctx) {
    const file = resolvePath(input.path, ctx.workspace);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, input.content, 'utf8');
    return ok(`Wrote ${Buffer.byteLength(input.content)} bytes to ${file}`);
  },
});

export const editTool = defineTool({
  name: 'edit',
  description:
    'Edit a file by exact string replacement. oldText must match exactly once (include enough surrounding context to be unique).',
  input: z.object({ path: z.string().min(1), oldText: z.string().min(1), newText: z.string() }),
  summarize: (i) => `edit ${i.path}`,
  async execute(input, ctx) {
    const file = resolvePath(input.path, ctx.workspace);
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return fail(`File not found: ${file}`);
      throw error;
    }
    const first = text.indexOf(input.oldText);
    if (first < 0) return fail(`oldText not found in ${file}`);
    if (text.indexOf(input.oldText, first + 1) >= 0)
      return fail(`oldText matches more than once in ${file}; add more context`);
    await fs.writeFile(
      file,
      text.slice(0, first) + input.newText + text.slice(first + input.oldText.length),
      'utf8',
    );
    return ok(`Edited ${file}`);
  },
});
