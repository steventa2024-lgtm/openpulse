import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface TestSuite {
  id: string;
  label: string;
  /** Ecosystem this suite belongs to. */
  ecosystem: 'node' | 'python' | 'rust' | 'go' | 'java' | 'dotnet';
  command: string;
  args: string[];
  /** Directory to run in, relative to the project root. */
  cwd: string;
  /** False when the tool is not installed on this machine. */
  available: boolean;
  /** Why it cannot run, and what to install. */
  reason?: string;
  /** Where the suite was found, e.g. "package.json scripts.test". */
  source: string;
}

const NODE_MANAGERS: { lockfile: string; command: string }[] = [
  { lockfile: 'pnpm-lock.yaml', command: 'pnpm' },
  { lockfile: 'yarn.lock', command: 'yarn' },
  { lockfile: 'bun.lockb', command: 'bun' },
  { lockfile: 'package-lock.json', command: 'npm' },
];

/**
 * Work out how this project runs its tests.
 *
 * Only suites that are actually declared are reported, and each one is checked against the tools
 * installed on this machine — a project with a pytest suite on a machine without Python is listed
 * as unavailable with the reason, rather than silently omitted or optimistically offered.
 */
export async function detectTestSuites(projectDir: string): Promise<TestSuite[]> {
  const suites: TestSuite[] = [];

  // ---- Node ------------------------------------------------------------------------------------
  const packageJson = await readJson(path.join(projectDir, 'package.json'));
  if (packageJson) {
    const scripts = (packageJson.scripts ?? {}) as Record<string, string>;
    const manager = await nodeManager(projectDir);
    for (const name of ['test', 'test:unit', 'test:integration', 'check']) {
      if (!scripts[name]) continue;
      suites.push({
        id: `node:${name}`,
        label: `${manager} run ${name}`,
        ecosystem: 'node',
        command: manager,
        args: manager === 'npm' ? ['run', name, '--silent'] : ['run', name],
        cwd: '.',
        available: await onPath(manager),
        source: `package.json scripts.${name}`,
      });
    }
  }

  // ---- Python ----------------------------------------------------------------------------------
  const pyproject = await readText(path.join(projectDir, 'pyproject.toml'));
  const hasPytestConfig =
    (await exists(path.join(projectDir, 'pytest.ini'))) ||
    (await exists(path.join(projectDir, 'tox.ini'))) ||
    (pyproject?.includes('[tool.pytest') ?? false);
  const hasTestsDir =
    (await exists(path.join(projectDir, 'tests'))) || (await exists(path.join(projectDir, 'test')));
  if (hasPytestConfig || (pyproject && hasTestsDir)) {
    suites.push({
      id: 'python:pytest',
      label: 'pytest',
      ecosystem: 'python',
      command: 'pytest',
      args: ['-q'],
      cwd: '.',
      available: await onPath('pytest'),
      ...(!(await onPath('pytest')) && {
        reason: 'pytest is not on PATH. Install it with: pip install pytest',
      }),
      source: hasPytestConfig ? 'pytest configuration' : 'pyproject.toml with a tests directory',
    });
  }

  // ---- Rust ------------------------------------------------------------------------------------
  if (await exists(path.join(projectDir, 'Cargo.toml'))) {
    suites.push({
      id: 'rust:cargo',
      label: 'cargo test',
      ecosystem: 'rust',
      command: 'cargo',
      args: ['test'],
      cwd: '.',
      available: await onPath('cargo'),
      ...(!(await onPath('cargo')) && {
        reason: 'cargo is not on PATH. Install Rust from https://rustup.rs',
      }),
      source: 'Cargo.toml',
    });
  }

  // ---- Go --------------------------------------------------------------------------------------
  if (await exists(path.join(projectDir, 'go.mod'))) {
    suites.push({
      id: 'go:test',
      label: 'go test ./...',
      ecosystem: 'go',
      command: 'go',
      args: ['test', './...'],
      cwd: '.',
      available: await onPath('go'),
      ...(!(await onPath('go')) && {
        reason: 'go is not on PATH. Install it from https://go.dev/dl',
      }),
      source: 'go.mod',
    });
  }

  // ---- Java ------------------------------------------------------------------------------------
  if (await exists(path.join(projectDir, 'pom.xml'))) {
    suites.push({
      id: 'java:maven',
      label: 'mvn test',
      ecosystem: 'java',
      command: 'mvn',
      args: ['-q', 'test'],
      cwd: '.',
      available: await onPath('mvn'),
      ...(!(await onPath('mvn')) && { reason: 'mvn is not on PATH.' }),
      source: 'pom.xml',
    });
  }
  const gradleWrapper = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
  if (
    (await exists(path.join(projectDir, 'build.gradle'))) ||
    (await exists(path.join(projectDir, 'build.gradle.kts')))
  ) {
    const hasWrapper = await exists(
      path.join(projectDir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'),
    );
    suites.push({
      id: 'java:gradle',
      label: hasWrapper ? `${gradleWrapper} test` : 'gradle test',
      ecosystem: 'java',
      command: hasWrapper ? gradleWrapper : 'gradle',
      args: ['test'],
      cwd: '.',
      available: hasWrapper || (await onPath('gradle')),
      ...(!hasWrapper &&
        !(await onPath('gradle')) && { reason: 'gradle is not on PATH and there is no wrapper.' }),
      source: hasWrapper ? 'gradle wrapper' : 'build.gradle',
    });
  }

  // ---- .NET ------------------------------------------------------------------------------------
  const dotnetProject = (await listFiles(projectDir)).find(
    (name) => name.endsWith('.sln') || name.endsWith('.csproj'),
  );
  if (dotnetProject) {
    suites.push({
      id: 'dotnet:test',
      label: 'dotnet test',
      ecosystem: 'dotnet',
      command: 'dotnet',
      args: ['test'],
      cwd: '.',
      available: await onPath('dotnet'),
      ...(!(await onPath('dotnet')) && { reason: 'dotnet is not on PATH.' }),
      source: dotnetProject,
    });
  }

  return suites;
}

const pathCache = new Map<string, boolean>();

/** Is a command runnable on this machine? Cached, since detection asks repeatedly. */
export async function onPath(command: string): Promise<boolean> {
  const cached = pathCache.get(command);
  if (cached !== undefined) return cached;
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    await run(probe, [command], { timeout: 5_000, windowsHide: true });
    pathCache.set(command, true);
    return true;
  } catch {
    pathCache.set(command, false);
    return false;
  }
}

export function clearPathCache(): void {
  pathCache.clear();
}

async function nodeManager(dir: string): Promise<string> {
  for (const { lockfile, command } of NODE_MANAGERS) {
    if (await exists(path.join(dir, lockfile))) return command;
  }
  return 'npm';
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function readText(file: string): Promise<string | undefined> {
  return fs.readFile(file, 'utf8').catch(() => undefined);
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  const text = await readText(file);
  if (!text) return undefined;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function listFiles(dir: string): Promise<string[]> {
  return fs
    .readdir(dir)
    .then((names) => names)
    .catch(() => []);
}
