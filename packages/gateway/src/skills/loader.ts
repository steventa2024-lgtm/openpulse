import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import type { OpenPulseConfig } from '../config/schema.js';
import { getPath } from '../config/store.js';

export type SkillSource = 'bundled' | 'managed' | 'workspace' | 'extra';

export interface SkillMetadata {
  emoji?: string;
  homepage?: string;
  always?: boolean;
  os?: string[];
  primaryEnv?: string;
  requires?: { bins?: string[]; anyBins?: string[]; env?: string[]; config?: string[] };
}

export interface SkillDefinition {
  name: string;
  description: string;
  source: SkillSource;
  baseDir: string;
  filePath: string;
  homepage?: string;
  userInvocable: boolean;
  disableModelInvocation: boolean;
  metadata: SkillMetadata;
  /** Markdown body (instructions), with {baseDir} expanded. */
  body: string;
}

export interface SkillStatus {
  name: string;
  description: string;
  source: SkillSource;
  baseDir: string;
  filePath: string;
  emoji?: string;
  homepage?: string;
  primaryEnv?: string;
  /** Explicitly disabled via skills.entries.<name>.enabled = false. */
  disabled: boolean;
  /** Requirements met (bins/env/config/os). */
  eligible: boolean;
  missing: { bins: string[]; anyBins: string[]; env: string[]; config: string[]; os: string[] };
  userInvocable: boolean;
  /** Configured API key present (skills.entries.<name>.apiKey). */
  hasApiKey: boolean;
  error?: string;
}

export interface SkillDirs {
  bundled?: string;
  managed?: string;
  workspace?: string;
  extra?: string[];
}

/**
 * Load skills from all locations. On a name clash, precedence is
 * workspace > managed (~/.openpulse/skills) > bundled > extraDirs.
 */
export async function loadSkills(
  dirs: SkillDirs,
): Promise<{ skills: SkillDefinition[]; errors: SkillStatus[] }> {
  const ordered: [string | undefined, SkillSource][] = [
    ...(dirs.extra ?? []).map((d): [string, SkillSource] => [d, 'extra']),
    [dirs.bundled, 'bundled'],
    [dirs.managed, 'managed'],
    [dirs.workspace, 'workspace'],
  ];
  const byName = new Map<string, SkillDefinition>();
  const errors: SkillStatus[] = [];

  for (const [dir, source] of ordered) {
    if (!dir || !fs.existsSync(dir)) continue;
    const children = await fsp.readdir(dir, { withFileTypes: true });
    for (const child of children
      .filter((c) => c.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const baseDir = path.join(dir, child.name);
      const filePath = path.join(baseDir, 'SKILL.md');
      if (!fs.existsSync(filePath)) continue;
      try {
        const skill = parseSkillFile(await fsp.readFile(filePath, 'utf8'), {
          baseDir,
          filePath,
          source,
        });
        byName.set(skill.name, skill);
      } catch (error) {
        errors.push({
          name: child.name,
          description: '',
          source,
          baseDir,
          filePath,
          disabled: false,
          eligible: false,
          missing: { bins: [], anyBins: [], env: [], config: [], os: [] },
          userInvocable: false,
          hasApiKey: false,
          error: (error as Error).message,
        });
      }
    }
  }
  return { skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), errors };
}

export function parseSkillFile(
  text: string,
  loc: { baseDir: string; filePath: string; source: SkillSource },
): SkillDefinition {
  const normalised = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(normalised);
  if (!m) throw new Error('SKILL.md must start with YAML frontmatter (--- … ---)');
  let fm: Record<string, unknown>;
  try {
    fm = (YAML.parse(m[1]!) as Record<string, unknown> | null) ?? {};
  } catch (error) {
    throw new Error(`invalid frontmatter: ${(error as Error).message}`, { cause: error });
  }
  const name = typeof fm.name === 'string' ? fm.name.trim() : '';
  const description = typeof fm.description === 'string' ? fm.description.trim() : '';
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name))
    throw new Error('frontmatter "name" must be lowercase letters, digits, - or _');
  if (!description) throw new Error('frontmatter "description" is required');

  let metaRaw = fm.metadata;
  if (typeof metaRaw === 'string') {
    try {
      metaRaw = JSON.parse(metaRaw);
    } catch {
      throw new Error('metadata must be a JSON object');
    }
  }
  const metaObj = (metaRaw ?? {}) as Record<string, unknown>;
  // Accept OpenClaw-authored skills too.
  const metadata = ((metaObj.openpulse ?? metaObj.openclaw ?? {}) as SkillMetadata) || {};

  const bool = (v: unknown, dflt: boolean) =>
    typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : dflt;
  const homepage = typeof fm.homepage === 'string' ? fm.homepage : metadata.homepage;

  return {
    name,
    description,
    ...loc,
    ...(homepage !== undefined && { homepage }),
    userInvocable: bool(fm['user-invocable'], true),
    disableModelInvocation: bool(fm['disable-model-invocation'], false),
    metadata,
    body: m[2]!.replaceAll('{baseDir}', loc.baseDir).trim(),
  };
}

export function evaluateSkill(
  skill: SkillDefinition,
  config: OpenPulseConfig,
  env: NodeJS.ProcessEnv = process.env,
): SkillStatus {
  const entry = config.skills.entries[skill.name];
  const req = skill.metadata.requires ?? {};
  const envFromConfig = { ...(entry?.env ?? {}) };
  if (skill.metadata.primaryEnv && entry?.apiKey)
    envFromConfig[skill.metadata.primaryEnv] = entry.apiKey;

  const missing = {
    bins: (req.bins ?? []).filter((b) => !onPath(b, env)),
    anyBins: req.anyBins?.length && !req.anyBins.some((b) => onPath(b, env)) ? req.anyBins : [],
    env: (req.env ?? []).filter((v) => !env[v] && !envFromConfig[v]),
    config: (req.config ?? []).filter((p) => !getPath(config, p)),
    os:
      skill.metadata.os?.length && !skill.metadata.os.includes(process.platform)
        ? skill.metadata.os
        : [],
  };
  const eligible =
    skill.metadata.always === true ||
    (missing.bins.length === 0 &&
      missing.anyBins.length === 0 &&
      missing.env.length === 0 &&
      missing.config.length === 0 &&
      missing.os.length === 0);

  return {
    name: skill.name,
    description: skill.description,
    source: skill.source,
    baseDir: skill.baseDir,
    filePath: skill.filePath,
    ...(skill.metadata.emoji !== undefined && { emoji: skill.metadata.emoji }),
    ...(skill.homepage !== undefined && { homepage: skill.homepage }),
    ...(skill.metadata.primaryEnv !== undefined && { primaryEnv: skill.metadata.primaryEnv }),
    disabled: entry?.enabled === false,
    eligible,
    missing,
    userInvocable: skill.userInvocable,
    hasApiKey: Boolean(entry?.apiKey),
  };
}

/** Env vars a skill contributes to tool processes (skills.entries.<name>.env / apiKey). */
export function skillEnv(
  skills: SkillDefinition[],
  config: OpenPulseConfig,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of skills) {
    const entry = config.skills.entries[s.name];
    if (!entry || entry.enabled === false) continue;
    Object.assign(out, entry.env ?? {});
    if (s.metadata.primaryEnv && entry.apiKey) out[s.metadata.primaryEnv] = entry.apiKey;
  }
  return out;
}

/** The skills block of the system prompt. */
export function formatSkillsForPrompt(skills: SkillDefinition[]): string {
  if (skills.length === 0) return '';
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const items = skills
    .map(
      (s) =>
        `  <skill>\n    <name>${esc(s.name)}</name>\n    <description>${esc(s.description)}</description>\n    <location>${esc(s.filePath)}</location>\n  </skill>`,
    )
    .join('\n');
  return `<available_skills>\n${items}\n</available_skills>`;
}

export function onPath(bin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === 'win32'
      ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase())]
      : [''];
  return dirs.some((dir) =>
    exts.some((ext) => {
      try {
        return fs.statSync(path.join(dir, bin + ext)).isFile();
      } catch {
        return false;
      }
    }),
  );
}
