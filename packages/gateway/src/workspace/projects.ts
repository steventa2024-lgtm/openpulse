import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { readTextOr, writeFileAtomic } from '../util/fs.js';

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(120),
  path: z.string().min(1),
  createdAt: z.number(),
  lastOpenedAt: z.number().optional(),
  /** Detected when the project is registered or refreshed. */
  vcs: z.enum(['git', 'none']).default('none'),
  remote: z.string().optional(),
  defaultBranch: z.string().optional(),
  /** Extra directories the agent may read while this project is active. */
  extraReadRoots: z.array(z.string()).default([]),
});

export const ProjectsFileSchema = z.object({
  version: z.literal(1).default(1),
  activeId: z.string().optional(),
  projects: z.array(ProjectSchema).default([]),
});

export type Project = z.output<typeof ProjectSchema>;
export type ProjectsFile = z.output<typeof ProjectsFileSchema>;

export class ProjectError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'INVALID_PATH' | 'DUPLICATE',
    message: string,
  ) {
    super(message);
    this.name = 'ProjectError';
  }
}

/** Directories no project may be rooted at, because "the whole machine" is not a project. */
function forbiddenRoots(): string[] {
  const home = os.homedir();
  const system =
    process.platform === 'win32'
      ? [
          process.env.SystemRoot ?? 'C:\\Windows',
          process.env.ProgramFiles ?? 'C:\\Program Files',
          'C:\\Program Files (x86)',
        ]
      : ['/', '/etc', '/usr', '/bin', '/sbin', '/var'];
  return [home, ...system].filter(Boolean).map((p) => path.resolve(p));
}

/**
 * The developer projects OpenPulse knows about.
 *
 * A project is just a directory on this machine, remembered with its git details so the editor,
 * git tools, checkpoints and agents all operate on the same place. The registry is also what
 * defines the agent's filesystem boundary, so registering a project is a deliberate act.
 */
export class ProjectStore {
  private data: ProjectsFile = { version: 1, projects: [] };
  private loaded = false;

  constructor(readonly file: string) {}

  async load(): Promise<ProjectsFile> {
    const text = await readTextOr(this.file, '');
    let raw: unknown;
    try {
      raw = text.trim() ? JSON.parse(text) : {};
    } catch {
      raw = {};
    }
    const parsed = ProjectsFileSchema.safeParse(raw);
    this.data = parsed.success ? parsed.data : { version: 1, projects: [] };
    this.loaded = true;
    return this.data;
  }

  private async ensure(): Promise<ProjectsFile> {
    if (!this.loaded) await this.load();
    return this.data;
  }

  async list(): Promise<Project[]> {
    const data = await this.ensure();
    return [...data.projects].sort(
      (a, b) => (b.lastOpenedAt ?? b.createdAt) - (a.lastOpenedAt ?? a.createdAt),
    );
  }

  async get(id: string): Promise<Project | undefined> {
    return (await this.ensure()).projects.find((p) => p.id === id);
  }

  async active(): Promise<Project | undefined> {
    const data = await this.ensure();
    return data.activeId ? data.projects.find((p) => p.id === data.activeId) : undefined;
  }

  /** Register a directory. The path must exist, be a directory, and not be a system location. */
  async add(input: { path: string; name?: string }): Promise<Project> {
    const data = await this.ensure();
    const resolved = path.resolve(expandHome(input.path));

    let stat;
    try {
      stat = await fsp.stat(resolved);
    } catch {
      throw new ProjectError('INVALID_PATH', `No such directory: ${resolved}`);
    }
    if (!stat.isDirectory()) throw new ProjectError('INVALID_PATH', `Not a directory: ${resolved}`);
    if (forbiddenRoots().some((root) => path.resolve(root) === resolved)) {
      throw new ProjectError(
        'INVALID_PATH',
        `${resolved} is too broad to use as a project. Pick the folder that holds one codebase.`,
      );
    }

    const existing = data.projects.find((p) => samePath(p.path, resolved));
    if (existing)
      throw new ProjectError('DUPLICATE', `That folder is already a project: ${existing.name}`);

    const git = detectGit(resolved);
    const project: Project = {
      id: randomUUID(),
      name: (input.name ?? path.basename(resolved)).slice(0, 120) || 'project',
      path: resolved,
      createdAt: Date.now(),
      vcs: git.isRepo ? 'git' : 'none',
      ...(git.remote ? { remote: git.remote } : {}),
      extraReadRoots: [],
    };
    data.projects.push(project);
    data.activeId ??= project.id;
    await this.save();
    return project;
  }

  async remove(id: string): Promise<boolean> {
    const data = await this.ensure();
    const before = data.projects.length;
    data.projects = data.projects.filter((p) => p.id !== id);
    if (data.activeId === id) data.activeId = data.projects[0]?.id;
    if (data.projects.length === before) return false;
    await this.save();
    return true;
  }

  async setActive(id: string): Promise<Project> {
    const data = await this.ensure();
    const project = data.projects.find((p) => p.id === id);
    if (!project) throw new ProjectError('NOT_FOUND', `No project with id ${id}`);
    project.lastOpenedAt = Date.now();
    data.activeId = id;
    await this.save();
    return project;
  }

  async patch(
    id: string,
    patch: Partial<Pick<Project, 'name' | 'remote' | 'vcs' | 'defaultBranch' | 'extraReadRoots'>>,
  ): Promise<Project> {
    const data = await this.ensure();
    const project = data.projects.find((p) => p.id === id);
    if (!project) throw new ProjectError('NOT_FOUND', `No project with id ${id}`);
    Object.assign(project, patch);
    await this.save();
    return project;
  }

  /** Every registered project path — the roots the agent is allowed to work in. */
  async roots(): Promise<string[]> {
    const data = await this.ensure();
    return data.projects.flatMap((p) => [p.path, ...p.extraReadRoots]);
  }

  private async save(): Promise<void> {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    await writeFileAtomic(this.file, `${JSON.stringify(this.data, null, 2)}\n`);
  }
}

export function samePath(a: string, b: string): boolean {
  const norm = (p: string) =>
    process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
  return norm(a) === norm(b);
}

export function expandHome(target: string): string {
  const trimmed = target.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\'))
    return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
}

/** Read git details straight from the working copy, without shelling out. */
export function detectGit(dir: string): { isRepo: boolean; remote?: string } {
  const gitPath = path.join(dir, '.git');
  if (!fs.existsSync(gitPath)) return { isRepo: false };
  try {
    const configFile = fs.statSync(gitPath).isDirectory()
      ? path.join(gitPath, 'config')
      : path.join(
          dir,
          fs
            .readFileSync(gitPath, 'utf8')
            .replace(/^gitdir:\s*/, '')
            .trim(),
          'config',
        );
    const config = fs.readFileSync(configFile, 'utf8');
    const remote = /\[remote "origin"\][^[]*?url\s*=\s*(.+)/m.exec(config)?.[1]?.trim();
    return { isRepo: true, ...(remote ? { remote } : {}) };
  } catch {
    return { isRepo: true };
  }
}
