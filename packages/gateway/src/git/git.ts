import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const MAX_BUFFER = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export interface GitFileChange {
  path: string;
  /** Index (staged) state, working-tree state; '.' means unchanged. */
  index: string;
  worktree: string;
  staged: boolean;
  untracked: boolean;
  renamedFrom?: string;
}

export interface GitStatus {
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  detached: boolean;
  clean: boolean;
  files: GitFileChange[];
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  body: string;
  refs: string;
}

export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
  upstream?: string;
  lastCommit?: string;
}

/**
 * A thin wrapper over the git CLI.
 *
 * Every call goes through execFile with an argument array — never a shell string — so branch names,
 * paths and messages cannot turn into commands. Callers get structured results and real git errors.
 */
export class GitRepo {
  constructor(
    readonly dir: string,
    private readonly options: { timeoutMs?: number; gitPath?: string } = {},
  ) {}

  /** Run git in this repository. `env` is merged over the process environment for this call only. */
  async git(
    args: string[],
    options: { input?: string; env?: NodeJS.ProcessEnv } = {},
  ): Promise<string> {
    try {
      const { stdout } = await run(this.options.gitPath ?? 'git', args, {
        cwd: this.dir,
        maxBuffer: MAX_BUFFER,
        timeout: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        windowsHide: true,
        encoding: 'utf8',
        ...(options.env && { env: { ...process.env, ...options.env } }),
        ...(options.input !== undefined && { input: options.input }),
      } as never);
      return typeof stdout === 'string' ? stdout : String(stdout);
    } catch (error) {
      const e = error as { stderr?: string; stdout?: string; code?: number; message: string };
      throw new GitError(
        (e.stderr || e.message || 'git failed').trim().split('\n')[0] ?? 'git failed',
        e.stderr ?? '',
        e.code ?? null,
      );
    }
  }

  async isRepo(): Promise<boolean> {
    try {
      const out = await this.git(['rev-parse', '--is-inside-work-tree']);
      return out.trim() === 'true';
    } catch {
      return false;
    }
  }

  /** The working-copy root, which may differ from the directory that was opened. */
  async root(): Promise<string> {
    return path.resolve((await this.git(['rev-parse', '--show-toplevel'])).trim());
  }

  async status(): Promise<GitStatus> {
    const out = await this.git(['status', '--porcelain=v2', '--branch', '--untracked-files=all']);
    const status: GitStatus = { ahead: 0, behind: 0, detached: false, clean: true, files: [] };

    for (const line of out.split('\n')) {
      if (!line) continue;
      if (line.startsWith('# branch.head ')) {
        const head = line.slice('# branch.head '.length).trim();
        if (head === '(detached)') status.detached = true;
        else status.branch = head;
        continue;
      }
      if (line.startsWith('# branch.upstream ')) {
        status.upstream = line.slice('# branch.upstream '.length).trim();
        continue;
      }
      if (line.startsWith('# branch.ab ')) {
        const [ahead, behind] = line.slice('# branch.ab '.length).trim().split(' ');
        status.ahead = Math.abs(Number(ahead ?? 0));
        status.behind = Math.abs(Number(behind ?? 0));
        continue;
      }
      if (line.startsWith('#')) continue;

      const change = parseStatusLine(line);
      if (change) status.files.push(change);
    }

    status.clean = status.files.length === 0;
    return status;
  }

  async currentBranch(): Promise<string | undefined> {
    const out = (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    return out === 'HEAD' ? undefined : out;
  }

  async branches(includeRemote = true): Promise<GitBranch[]> {
    const format = '%(refname:short)%09%(HEAD)%09%(upstream:short)%09%(objectname:short)';
    const args = ['for-each-ref', `--format=${format}`, 'refs/heads'];
    if (includeRemote) args.push('refs/remotes');
    const out = await this.git(args);
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name = '', head = '', upstream = '', commit = ''] = line.split('\t');
        return {
          name,
          current: head.trim() === '*',
          remote:
            name.startsWith('origin/') || name.includes('/') === false
              ? name.startsWith('origin/')
              : true,
          ...(upstream ? { upstream } : {}),
          ...(commit ? { lastCommit: commit } : {}),
        };
      })
      .filter((b) => b.name && !b.name.endsWith('/HEAD'));
  }

  async log(limit = 30, ref?: string): Promise<GitCommit[]> {
    const separator = '\u0001';
    const record = '\u0002';
    const format = ['%H', '%h', '%an', '%ae', '%aI', '%s', '%b', '%D'].join(separator);
    const args = [
      'log',
      `--max-count=${Math.min(Math.max(limit, 1), 500)}`,
      `--format=${format}${record}`,
    ];
    if (ref) args.push(ref);
    const out = await this.git(args);
    return out
      .split(record)
      .map((entry) => entry.replace(/^\n/, ''))
      .filter(Boolean)
      .map((entry) => {
        const [
          hash = '',
          shortHash = '',
          author = '',
          email = '',
          date = '',
          subject = '',
          body = '',
          refs = '',
        ] = entry.split(separator);
        return { hash, shortHash, author, email, date, subject, body: body.trim(), refs };
      });
  }

  /** Unified diff. `staged` compares the index to HEAD; otherwise the working tree to the index. */
  async diff(
    options: { staged?: boolean; file?: string; contextLines?: number; against?: string } = {},
  ): Promise<string> {
    const args = ['diff', '--no-color', `--unified=${options.contextLines ?? 3}`];
    if (options.staged) args.push('--staged');
    if (options.against) args.push(options.against);
    if (options.file) args.push('--', options.file);
    return this.git(args);
  }

  /** Diff for a single file including untracked ones, which plain `git diff` ignores. */
  async diffFile(file: string, options: { staged?: boolean } = {}): Promise<string> {
    const tracked = await this.isTracked(file);
    if (tracked)
      return this.diff({ file, ...(options.staged !== undefined && { staged: options.staged }) });
    return this.git(['diff', '--no-color', '--no-index', '--', devNull(), file]).catch(
      (error: unknown) => {
        // --no-index exits 1 when files differ, which is the normal case here.
        const stdout = (error as GitError).stderr;
        if (stdout) throw error;
        return '';
      },
    );
  }

  async isTracked(file: string): Promise<boolean> {
    try {
      const out = await this.git(['ls-files', '--error-unmatch', '--', file]);
      return out.trim().length > 0;
    } catch {
      return false;
    }
  }

  async add(files: string[]): Promise<void> {
    if (files.length === 0) return;
    await this.git(['add', '--', ...files]);
  }

  async commit(
    message: string,
    options: { allowEmpty?: boolean; author?: string } = {},
  ): Promise<string> {
    const args = ['commit', '--message', message];
    if (options.allowEmpty) args.push('--allow-empty');
    if (options.author) args.push('--author', options.author);
    await this.git(args);
    return (await this.git(['rev-parse', 'HEAD'])).trim();
  }

  async checkout(branch: string, options: { create?: boolean; from?: string } = {}): Promise<void> {
    const args = options.create ? ['checkout', '-b', branch] : ['checkout', branch];
    if (options.create && options.from) args.push(options.from);
    await this.git(args);
  }

  async fetch(remote = 'origin'): Promise<string> {
    return this.git(['fetch', '--prune', remote]);
  }

  async remotes(): Promise<{ name: string; url: string }[]> {
    const out = await this.git(['remote', '-v']);
    const seen = new Map<string, string>();
    for (const line of out.split('\n').filter(Boolean)) {
      const [name = '', rest = ''] = line.split('\t');
      const url = rest.split(' ')[0] ?? '';
      if (name && url && !seen.has(name)) seen.set(name, url);
    }
    return [...seen].map(([name, url]) => ({ name, url }));
  }

  /** Contents of a file at a revision, for side-by-side comparison. */
  async show(ref: string, file: string): Promise<string> {
    return this.git(['show', `${ref}:${file.replace(/\\/g, '/')}`]);
  }

  async hashObject(content: string): Promise<string> {
    return (await this.git(['hash-object', '-w', '--stdin'], { input: content })).trim();
  }
}

/** Is git usable on this machine? Cached, because this is asked on most pages. */
let gitVersion: string | undefined | null = null;
export async function gitAvailable(
  gitPath = 'git',
): Promise<{ available: boolean; version?: string }> {
  if (gitVersion !== null) {
    return gitVersion ? { available: true, version: gitVersion } : { available: false };
  }
  try {
    const { stdout } = await run(gitPath, ['--version'], { timeout: 10_000, windowsHide: true });
    gitVersion = String(stdout).trim();
    return { available: true, version: gitVersion };
  } catch {
    gitVersion = undefined;
    return { available: false };
  }
}

/** Only for tests, which need to re-probe. */
export function resetGitAvailability(): void {
  gitVersion = null;
}

/** Clone a repository into `targetDir`. The URL is passed as an argument, never through a shell. */
export async function gitClone(
  url: string,
  targetDir: string,
  options: { depth?: number; branch?: string; timeoutMs?: number } = {},
): Promise<void> {
  const args = ['clone'];
  if (options.depth) args.push('--depth', String(options.depth));
  if (options.branch) args.push('--branch', options.branch);
  args.push('--', url, targetDir);
  try {
    await run('git', args, {
      maxBuffer: MAX_BUFFER,
      timeout: options.timeoutMs ?? 15 * 60_000,
      windowsHide: true,
    });
  } catch (error) {
    const e = error as { stderr?: string; message: string; code?: number };
    throw new GitError(
      (e.stderr || e.message).trim().split('\n').slice(-1)[0] ?? 'clone failed',
      e.stderr ?? '',
      e.code ?? null,
    );
  }
}

function parseStatusLine(line: string): GitFileChange | undefined {
  const kind = line[0];
  if (kind === '?') {
    return { path: line.slice(2), index: '?', worktree: '?', staged: false, untracked: true };
  }
  if (kind === '1' || kind === '2') {
    const parts = line.split(' ');
    const xy = parts[1] ?? '..';
    const index = xy[0] ?? '.';
    const worktree = xy[1] ?? '.';
    if (kind === '1') {
      const filePath = parts.slice(8).join(' ');
      return { path: filePath, index, worktree, staged: index !== '.', untracked: false };
    }
    // Renames put "new\told" after the score field.
    const rest = parts.slice(9).join(' ');
    const [to = '', from = ''] = rest.split('\t');
    return {
      path: to,
      index,
      worktree,
      staged: index !== '.',
      untracked: false,
      renamedFrom: from,
    };
  }
  if (kind === 'u') {
    const parts = line.split(' ');
    return {
      path: parts.slice(10).join(' '),
      index: 'U',
      worktree: 'U',
      staged: false,
      untracked: false,
    };
  }
  return undefined;
}

function devNull(): string {
  return process.platform === 'win32' ? 'NUL' : '/dev/null';
}
