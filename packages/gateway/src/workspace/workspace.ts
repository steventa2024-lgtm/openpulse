import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readTextOr, writeFileIfMissing } from '../util/fs.js';
import {
  AGENTS_TEMPLATE,
  BOOTSTRAP_TEMPLATE,
  HEARTBEAT_TEMPLATE,
  IDENTITY_TEMPLATE,
  SOUL_TEMPLATE,
  TOOLS_TEMPLATE,
  USER_TEMPLATE,
} from './templates.js';

export const BOOTSTRAP_FILES = [
  'AGENTS.md',
  'SOUL.md',
  'TOOLS.md',
  'IDENTITY.md',
  'USER.md',
  'HEARTBEAT.md',
  'BOOTSTRAP.md',
] as const;

const TEMPLATES: Record<string, string> = {
  'AGENTS.md': AGENTS_TEMPLATE,
  'SOUL.md': SOUL_TEMPLATE,
  'TOOLS.md': TOOLS_TEMPLATE,
  'IDENTITY.md': IDENTITY_TEMPLATE,
  'USER.md': USER_TEMPLATE,
  'HEARTBEAT.md': HEARTBEAT_TEMPLATE,
};

export interface EnsureResult {
  dir: string;
  created: string[];
  brandNew: boolean;
}

/**
 * Create the workspace and any missing default files. BOOTSTRAP.md is only created for a brand
 * new workspace, so deleting it after the first-run ritual is permanent.
 */
export async function ensureWorkspace(
  dir: string,
  options: { skipBootstrap?: boolean } = {},
): Promise<EnsureResult> {
  await fsp.mkdir(path.join(dir, 'memory'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'skills'), { recursive: true });
  const brandNew = !Object.keys(TEMPLATES).some((name) => fs.existsSync(path.join(dir, name)));
  const created: string[] = [];
  if (options.skipBootstrap) return { dir, created, brandNew };

  for (const [name, content] of Object.entries(TEMPLATES)) {
    if (await writeFileIfMissing(path.join(dir, name), content)) created.push(name);
  }
  if (brandNew && (await writeFileIfMissing(path.join(dir, 'BOOTSTRAP.md'), BOOTSTRAP_TEMPLATE))) {
    created.push('BOOTSTRAP.md');
  }
  return { dir, created, brandNew };
}

export interface BootstrapFile {
  name: string;
  path: string;
  content: string;
  missing: boolean;
  truncated: boolean;
}

/**
 * Files injected into the system prompt ("Project Context"). Blank files are skipped, large ones
 * truncated with a marker, missing required ones get a one-line marker. MEMORY.md is only
 * included for the main private session.
 */
export async function loadBootstrapFiles(
  dir: string,
  options: { includeMemory: boolean; maxChars: number; totalMaxChars: number },
): Promise<BootstrapFile[]> {
  const names: string[] = [...BOOTSTRAP_FILES];
  if (options.includeMemory) names.push('MEMORY.md');

  const out: BootstrapFile[] = [];
  let budget = options.totalMaxChars;
  for (const name of names) {
    const file = path.join(dir, name);
    const exists = fs.existsSync(file);
    const optional = name === 'BOOTSTRAP.md' || name === 'MEMORY.md';
    if (!exists) {
      if (!optional) out.push({ name, path: file, content: '', missing: true, truncated: false });
      continue;
    }
    let content = (await readTextOr(file, '')).trim();
    if (content === '') continue;
    let truncated = false;
    const limit = Math.min(options.maxChars, Math.max(0, budget));
    if (content.length > limit) {
      content = `${content.slice(0, limit)}\n\n[…truncated — read ${name} for the full content]`;
      truncated = true;
    }
    budget -= content.length;
    out.push({ name, path: file, content, missing: false, truncated });
    if (budget <= 0) break;
  }
  return out;
}

/** True when HEARTBEAT.md has no actionable content (only blanks, headings, comments). */
export function isHeartbeatFileEmpty(text: string): boolean {
  const withoutHtmlComments = text.replace(/<!--[\s\S]*?-->/g, '');
  return withoutHtmlComments
    .split(/\r?\n/)
    .map((l) => l.trim())
    .every((l) => l === '' || /^#/.test(l) || /^[-*+]\s*(\[[ xX]?\])?\s*$/.test(l));
}

export function dailyMemoryPath(dir: string, date = new Date(), timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
  return path.join(dir, 'memory', `${parts}.md`);
}

export function isInsideWorkspace(dir: string, target: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
