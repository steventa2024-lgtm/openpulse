import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { GitRepo, gitClone } from '../git/git.js';
import { parseSkillFile, type SkillDefinition } from './loader.js';

export interface SkillValidation {
  valid: boolean;
  name?: string;
  description?: string;
  errors: string[];
  warnings: string[];
  /** Files that could run code if something invoked them. Shown, never executed. */
  executables: string[];
  files: number;
  bytes: number;
}

export interface InstalledSkillInfo {
  name: string;
  dir: string;
  source: 'managed' | 'workspace';
  /** Where it was installed from, when we know. */
  origin?:
    | { kind: 'git'; url: string; commit?: string }
    | { kind: 'local'; path: string }
    | { kind: 'template' };
  installedAt?: number;
}

export class SkillRegistryError extends Error {
  constructor(
    readonly code: 'INVALID' | 'EXISTS' | 'NOT_FOUND' | 'FORBIDDEN',
    message: string,
  ) {
    super(message);
    this.name = 'SkillRegistryError';
  }
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const EXECUTABLE_EXTENSIONS = new Set([
  '.sh',
  '.bash',
  '.ps1',
  '.bat',
  '.cmd',
  '.exe',
  '.js',
  '.mjs',
  '.cjs',
  '.py',
  '.rb',
]);
const MAX_SKILL_BYTES = 20 * 1024 * 1024;
const ORIGIN_FILE = '.openpulse-origin.json';

/**
 * Installing, validating and removing skills.
 *
 * A skill is a folder with a SKILL.md, and installing one means copying (or cloning) that folder —
 * nothing more. Scripts a skill ships are listed so the developer can see them, but no install hook
 * is ever run: a skill only does something when the agent reads its instructions and chooses to.
 */
export class SkillRegistry {
  constructor(
    readonly managedDir: string,
    readonly workspaceSkillsDir: string,
  ) {}

  /** Check a skill folder without installing it. */
  async validate(dir: string): Promise<SkillValidation> {
    const result: SkillValidation = {
      valid: false,
      errors: [],
      warnings: [],
      executables: [],
      files: 0,
      bytes: 0,
    };
    const skillFile = path.join(dir, 'SKILL.md');

    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      result.errors.push(`${dir} is not a folder.`);
      return result;
    }
    if (!fs.existsSync(skillFile)) {
      result.errors.push('There is no SKILL.md in this folder.');
      return result;
    }

    let skill: SkillDefinition | undefined;
    try {
      skill = parseSkillFile(await fsp.readFile(skillFile, 'utf8'), {
        baseDir: dir,
        filePath: skillFile,
        source: 'managed',
      });
    } catch (error) {
      result.errors.push((error as Error).message);
    }

    if (skill) {
      result.name = skill.name;
      result.description = skill.description;
      if (!NAME_PATTERN.test(skill.name)) {
        result.errors.push(
          `The name "${skill.name}" must be lowercase letters, digits and dashes.`,
        );
      }
      if (skill.description.length < 10) {
        result.warnings.push(
          'The description is very short; the agent uses it to decide when the skill applies.',
        );
      }
      if (skill.body.trim().length < 20) {
        result.warnings.push('SKILL.md has almost no instructions.');
      }
    }

    await walk(dir, (file, stat) => {
      result.files += 1;
      result.bytes += stat.size;
      const extension = path.extname(file).toLowerCase();
      if (EXECUTABLE_EXTENSIONS.has(extension) || (stat.mode & 0o111) !== 0) {
        result.executables.push(path.relative(dir, file).replace(/\\/g, '/'));
      }
    });

    if (result.bytes > MAX_SKILL_BYTES) {
      result.errors.push(
        `The skill is ${Math.round(result.bytes / 1024 / 1024)} MB; the limit is 20 MB.`,
      );
    }
    if (result.executables.length > 0) {
      result.warnings.push(
        `This skill ships ${result.executables.length} script${result.executables.length === 1 ? '' : 's'}. They are copied but never run on install; the agent may run them later, under the usual approval rules.`,
      );
    }

    result.valid = result.errors.length === 0;
    return result;
  }

  /** Copy a local skill folder into the managed skills directory. */
  async importLocal(
    source: string,
    options: { overwrite?: boolean } = {},
  ): Promise<InstalledSkillInfo> {
    const validation = await this.validate(source);
    if (!validation.valid || !validation.name) {
      throw new SkillRegistryError('INVALID', validation.errors.join(' ') || 'Not a valid skill.');
    }
    const target = path.join(this.managedDir, validation.name);
    await this.prepareTarget(target, options.overwrite);
    await fsp.cp(source, target, {
      recursive: true,
      filter: (item) =>
        !item.split(path.sep).includes('.git') && !item.split(path.sep).includes('node_modules'),
    });
    const info: InstalledSkillInfo = {
      name: validation.name,
      dir: target,
      source: 'managed',
      origin: { kind: 'local', path: path.resolve(source) },
      installedAt: Date.now(),
    };
    await writeOrigin(target, info);
    return info;
  }

  /**
   * Clone a skill from a git repository. `subdir` selects one skill inside a repository that holds
   * several. Only the clone happens — no hooks, no package installs.
   */
  async installFromGit(
    url: string,
    options: { subdir?: string; overwrite?: boolean; branch?: string } = {},
  ): Promise<InstalledSkillInfo> {
    if (!/^(https:\/\/|git@|ssh:\/\/|file:\/\/|[A-Za-z]:[\\/]|\/)/.test(url)) {
      throw new SkillRegistryError('INVALID', 'Use an https, ssh or local path git URL.');
    }
    const staging = path.join(this.managedDir, `.staging-${Date.now()}`);
    await fsp.mkdir(this.managedDir, { recursive: true });
    try {
      await gitClone(url, staging, {
        depth: 1,
        exactBytes: true,
        ...(options.branch && { branch: options.branch }),
      });
      const skillDir = options.subdir ? path.join(staging, options.subdir) : staging;
      if (!path.resolve(skillDir).startsWith(path.resolve(staging))) {
        throw new SkillRegistryError('FORBIDDEN', 'The subfolder must be inside the repository.');
      }
      const validation = await this.validate(skillDir);
      if (!validation.valid || !validation.name) {
        throw new SkillRegistryError(
          'INVALID',
          validation.errors.join(' ') || 'The repository does not contain a valid skill.',
        );
      }
      const commit = await new GitRepo(staging)
        .git(['rev-parse', 'HEAD'])
        .then((out) => out.trim())
        .catch(() => undefined);
      const target = path.join(this.managedDir, validation.name);
      await this.prepareTarget(target, options.overwrite);
      await fsp.cp(skillDir, target, {
        recursive: true,
        filter: (item) => !item.split(path.sep).includes('.git'),
      });
      const info: InstalledSkillInfo = {
        name: validation.name,
        dir: target,
        source: 'managed',
        origin: {
          kind: 'git',
          url,
          ...(commit && { commit }),
          ...(options.subdir && { subdir: options.subdir }),
        },
        installedAt: Date.now(),
      };
      await writeOrigin(target, info);
      return info;
    } finally {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Re-install a git-sourced skill from its origin, picking up upstream changes. */
  async update(name: string): Promise<InstalledSkillInfo> {
    const dir = path.join(this.managedDir, name);
    const origin = await readOrigin(dir);
    if (!origin?.origin)
      throw new SkillRegistryError('NOT_FOUND', `No record of where "${name}" came from.`);
    if (origin.origin.kind === 'git') {
      const subdir = (origin.origin as { subdir?: string }).subdir;
      return this.installFromGit(origin.origin.url, { overwrite: true, ...(subdir && { subdir }) });
    }
    if (origin.origin.kind === 'local')
      return this.importLocal(origin.origin.path, { overwrite: true });
    throw new SkillRegistryError(
      'INVALID',
      `"${name}" was created from a template and has nothing to update from.`,
    );
  }

  /** Scaffold a new skill in the workspace from the starter template. */
  async create(input: {
    name: string;
    description: string;
    where?: 'workspace' | 'managed';
  }): Promise<InstalledSkillInfo> {
    if (!NAME_PATTERN.test(input.name)) {
      throw new SkillRegistryError(
        'INVALID',
        'Use lowercase letters, digits and dashes for the name.',
      );
    }
    const root = input.where === 'managed' ? this.managedDir : this.workspaceSkillsDir;
    const target = path.join(root, input.name);
    if (fs.existsSync(target))
      throw new SkillRegistryError('EXISTS', `A skill called "${input.name}" already exists.`);
    await fsp.mkdir(target, { recursive: true });
    await fsp.writeFile(
      path.join(target, 'SKILL.md'),
      starterTemplate(input.name, input.description),
      'utf8',
    );
    const info: InstalledSkillInfo = {
      name: input.name,
      dir: target,
      source: input.where === 'managed' ? 'managed' : 'workspace',
      origin: { kind: 'template' },
      installedAt: Date.now(),
    };
    await writeOrigin(target, info);
    return info;
  }

  /** Remove a managed or workspace skill. Bundled skills can only be disabled. */
  async remove(name: string): Promise<{ removed: string }> {
    for (const root of [this.managedDir, this.workspaceSkillsDir]) {
      const dir = path.join(root, name);
      if (!path.resolve(dir).startsWith(path.resolve(root) + path.sep)) continue;
      if (fs.existsSync(path.join(dir, 'SKILL.md'))) {
        await fsp.rm(dir, { recursive: true, force: true });
        return { removed: dir };
      }
    }
    throw new SkillRegistryError(
      'NOT_FOUND',
      `"${name}" is not an installed or workspace skill. Bundled skills can be disabled but not removed.`,
    );
  }

  async origin(name: string): Promise<InstalledSkillInfo | undefined> {
    for (const root of [this.managedDir, this.workspaceSkillsDir]) {
      const found = await readOrigin(path.join(root, name));
      if (found) return found;
    }
    return undefined;
  }

  private async prepareTarget(target: string, overwrite?: boolean): Promise<void> {
    if (fs.existsSync(target)) {
      if (!overwrite) {
        throw new SkillRegistryError(
          'EXISTS',
          `A skill called "${path.basename(target)}" is already installed.`,
        );
      }
      await fsp.rm(target, { recursive: true, force: true });
    }
    await fsp.mkdir(path.dirname(target), { recursive: true });
  }
}

export function starterTemplate(name: string, description: string): string {
  return `---
name: ${name}
description: ${description.replace(/\n/g, ' ')}
# Optional: gate the skill on what the machine has.
# metadata:
#   openpulse:
#     requires:
#       bins: [git]
#       env: [EXAMPLE_API_KEY]
---

# ${name}

Explain, for the agent, when this skill applies and how to carry it out.

## When to use it

- Describe the requests or situations this skill is for.

## How to do it

1. Step one — be concrete about commands, files and checks.
2. Step two.

## Notes

- Anything the agent should be careful about.
`;
}

async function walk(dir: string, visit: (file: string, stat: fs.Stats) => void): Promise<void> {
  const children = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const child of children) {
    if (child.name === '.git' || child.name === 'node_modules') continue;
    const full = path.join(dir, child.name);
    if (child.isDirectory()) await walk(full, visit);
    else if (child.isFile()) visit(full, await fsp.stat(full));
  }
}

async function writeOrigin(dir: string, info: InstalledSkillInfo): Promise<void> {
  await fsp.writeFile(path.join(dir, ORIGIN_FILE), `${JSON.stringify(info, null, 2)}\n`, 'utf8');
}

async function readOrigin(dir: string): Promise<InstalledSkillInfo | undefined> {
  try {
    return JSON.parse(
      await fsp.readFile(path.join(dir, ORIGIN_FILE), 'utf8'),
    ) as InstalledSkillInfo;
  } catch {
    return undefined;
  }
}
