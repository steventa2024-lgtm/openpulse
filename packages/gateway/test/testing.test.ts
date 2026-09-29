import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectTestSuites, onPath } from '../src/testing/detect.js';
import { parseFailures, TestRunner } from '../src/testing/runner.js';
import { tempDir } from './helpers.js';

async function nodeProject(testScript: string): Promise<string> {
  const dir = await tempDir('openpulse-tests-');
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'sample', version: '1.0.0', scripts: { test: testScript } }, null, 2),
  );
  await fs.writeFile(path.join(dir, 'package-lock.json'), '{}');
  return dir;
}

describe('test suite detection', () => {
  it('finds a Node test script and the package manager from the lockfile', async () => {
    const dir = await nodeProject('node check.js');
    const suites = await detectTestSuites(dir);

    expect(suites).toHaveLength(1);
    expect(suites[0]).toMatchObject({
      id: 'node:test',
      ecosystem: 'node',
      command: 'npm',
      source: 'package.json scripts.test',
    });
    expect(suites[0]!.available).toBe(await onPath('npm'));
  });

  it('prefers pnpm when the project uses it', async () => {
    const dir = await nodeProject('vitest run');
    await fs.rm(path.join(dir, 'package-lock.json'));
    await fs.writeFile(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9');

    const [suite] = await detectTestSuites(dir);
    expect(suite).toMatchObject({ command: 'pnpm', args: ['run', 'test'] });
  });

  it('recognises other ecosystems from their manifests', async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, 'Cargo.toml'), '[package]\nname = "x"\n');
    await fs.writeFile(path.join(dir, 'go.mod'), 'module example.com/x\n');
    await fs.writeFile(path.join(dir, 'pytest.ini'), '[pytest]\n');

    const ids = (await detectTestSuites(dir)).map((s) => s.id).sort();
    expect(ids).toEqual(['go:test', 'python:pytest', 'rust:cargo']);
  });

  it('marks a suite unavailable when its tool is missing, with the reason', async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, 'Cargo.toml'), '[package]\nname = "x"\n');

    const [suite] = await detectTestSuites(dir);
    if (!(await onPath('cargo'))) {
      expect(suite!.available).toBe(false);
      expect(suite!.reason).toContain('rustup');
    }
  });

  it('reports nothing for a folder with no test setup', async () => {
    await expect(detectTestSuites(await tempDir())).resolves.toEqual([]);
  });
});

describe('test runner', () => {
  /** A suite that runs a small script with Node itself, so the test needs no package manager. */
  async function scriptSuite(source: string) {
    const dir = await tempDir('openpulse-run-');
    await fs.writeFile(path.join(dir, 'check.js'), source);
    return {
      dir,
      suite: {
        id: 'node:test',
        label: 'node check.js',
        ecosystem: 'node' as const,
        command: process.execPath,
        args: ['check.js'],
        cwd: '.',
        available: true,
        source: 'test',
      },
    };
  }

  it('reports a passing run from the exit code, with the output', async () => {
    const { dir, suite } = await scriptSuite('console.log("all 3 tests passed"); process.exit(0);');
    const runner = new TestRunner();

    const run = await runner.run({ projectId: 'p1', projectDir: dir, suite });
    expect(run.status).toBe('passed');
    expect(run.exitCode).toBe(0);
    expect(run.output).toContain('all 3 tests passed');
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports a failing run and parses the failures it can', async () => {
    const { dir, suite } = await scriptSuite(
      'console.log(" FAIL  test/auth.test.ts > login > rejects a bad password"); console.log("AssertionError: expected true to be false"); process.exit(1);',
    );
    const runner = new TestRunner();

    const run = await runner.run({ projectId: 'p1', projectDir: dir, suite });
    expect(run.status).toBe('failed');
    expect(run.exitCode).toBe(1);
    expect(run.failures[0]!.name).toContain('rejects a bad password');
  });

  it('streams output as it is produced', async () => {
    const { dir, suite } = await scriptSuite('console.log("first"); console.error("second");');
    const runner = new TestRunner();
    const chunks: string[] = [];
    runner.on('output', (event) => chunks.push(event.chunk));

    await runner.run({ projectId: 'p1', projectDir: dir, suite });
    expect(chunks.join('')).toContain('first');
    expect(chunks.join('')).toContain('second');
  });

  it('cancels a long run and records it as cancelled, not failed', async () => {
    const { dir, suite } = await scriptSuite('setTimeout(() => process.exit(0), 60_000);');
    const runner = new TestRunner();

    const running = runner.run({ projectId: 'p1', projectDir: dir, suite });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const [current] = runner.history('p1');
    expect(runner.cancel(current!.id)).toBe(true);

    const run = await running;
    expect(run.status).toBe('cancelled');
  });

  it('explains a command that is not installed', async () => {
    const { dir, suite } = await scriptSuite('');
    const runner = new TestRunner();

    const run = await runner.run({
      projectId: 'p1',
      projectDir: dir,
      suite: { ...suite, command: 'definitely-not-a-real-test-tool', args: [] },
    });
    expect(['error', 'failed']).toContain(run.status);
  });

  it('keeps history per project, newest first', async () => {
    const { dir, suite } = await scriptSuite('process.exit(0);');
    const runner = new TestRunner();
    await runner.run({ projectId: 'p1', projectDir: dir, suite });
    await runner.run({ projectId: 'p2', projectDir: dir, suite });
    await runner.run({ projectId: 'p1', projectDir: dir, suite });

    expect(runner.history('p1')).toHaveLength(2);
    expect(runner.history()).toHaveLength(3);
  });
});

describe('failure parsing', () => {
  it('reads pytest, cargo and go failure lines', () => {
    expect(
      parseFailures('FAILED tests/test_auth.py::test_login - AssertionError', 'python')[0]!.name,
    ).toBe('tests/test_auth.py::test_login');
    expect(parseFailures('test auth::tests::login ... FAILED', 'rust')[0]!.name).toBe(
      'auth::tests::login',
    );
    expect(parseFailures('--- FAIL: TestLogin (0.00s)', 'go')[0]!.name).toBe('TestLogin');
  });

  it('returns nothing rather than inventing failures', () => {
    expect(parseFailures('everything is fine\nall good', 'go')).toEqual([]);
  });
});
