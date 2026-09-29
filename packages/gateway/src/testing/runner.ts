import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import type { TestSuite } from './detect.js';

export interface TestRun {
  id: string;
  projectId: string;
  suiteId: string;
  label: string;
  command: string;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  status: 'running' | 'passed' | 'failed' | 'cancelled' | 'error';
  exitCode?: number | null;
  /** Everything the command printed, capped. */
  output: string;
  /** Failures parsed from the output; clearly derived, never invented. */
  failures: TestFailure[];
  error?: string;
}

export interface TestFailure {
  /** Test name or file, as printed by the tool. */
  name: string;
  /** The lines around the failure, for context. */
  detail: string;
}

export interface TestOutputEvent {
  runId: string;
  chunk: string;
  stream: 'stdout' | 'stderr';
}

const MAX_OUTPUT_CHARS = 512 * 1024;

/**
 * Runs a project's own test command and keeps the result.
 *
 * Nothing is simulated: the configured command is spawned in the project directory, its output is
 * streamed as it arrives, and pass or fail comes from the process exit code. Failure names are
 * parsed from the output where the tool's format allows, and marked as parsed rather than
 * presented as structured results the tool did not give us.
 */
export class TestRunner extends EventEmitter<{
  output: [TestOutputEvent];
  finished: [TestRun];
  started: [TestRun];
}> {
  private readonly runs = new Map<string, TestRun>();
  private readonly processes = new Map<string, ChildProcess>();

  constructor(private readonly options: { maxHistory?: number; spawnFn?: typeof spawn } = {}) {
    super();
    this.setMaxListeners(50);
  }

  history(projectId?: string, limit = 25): TestRun[] {
    return [...this.runs.values()]
      .filter((run) => !projectId || run.projectId === projectId)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit);
  }

  get(id: string): TestRun | undefined {
    return this.runs.get(id);
  }

  /** Start a suite. Resolves when the process exits. */
  async run(input: { projectId: string; projectDir: string; suite: TestSuite }): Promise<TestRun> {
    const { projectId, projectDir, suite } = input;
    const run: TestRun = {
      id: randomUUID(),
      projectId,
      suiteId: suite.id,
      label: suite.label,
      command: [suite.command, ...suite.args].join(' '),
      startedAt: Date.now(),
      status: 'running',
      output: '',
      failures: [],
    };
    this.runs.set(run.id, run);
    this.prune();
    this.emit('started', run);

    const spawnFn = this.options.spawnFn ?? spawn;
    // On Windows npm, pnpm, yarn and gradlew are .cmd shims that only a shell can start. An
    // absolute path to a real executable does not need one (and would break on spaces if given it).
    const useShell = process.platform === 'win32' && !path.isAbsolute(suite.command);
    const child = spawnFn(
      useShell ? quoteForShell(suite.command) : suite.command,
      useShell ? suite.args.map(quoteForShell) : suite.args,
      {
        cwd: path.resolve(projectDir, suite.cwd || '.'),
        windowsHide: true,
        shell: useShell,
        env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
      },
    );
    this.processes.set(run.id, child);

    const append = (chunk: string, stream: 'stdout' | 'stderr') => {
      run.output = `${run.output}${chunk}`.slice(-MAX_OUTPUT_CHARS);
      this.emit('output', { runId: run.id, chunk, stream });
    };
    child.stdout?.on('data', (data: Buffer) => append(data.toString(), 'stdout'));
    child.stderr?.on('data', (data: Buffer) => append(data.toString(), 'stderr'));

    await new Promise<void>((resolve) => {
      child.on('error', (error) => {
        run.status = 'error';
        run.error = error.message.includes('ENOENT')
          ? `${suite.command} is not installed or not on PATH.`
          : error.message;
        resolve();
      });
      child.on('close', (code) => {
        if (run.status === 'running') {
          run.exitCode = code;
          run.status = code === 0 ? 'passed' : 'failed';
        }
        resolve();
      });
    });

    this.processes.delete(run.id);
    run.finishedAt = Date.now();
    run.durationMs = run.finishedAt - run.startedAt;
    if (run.status === 'failed') run.failures = parseFailures(run.output, suite.ecosystem);
    this.emit('finished', run);
    return run;
  }

  /** Stop a running suite. The run is recorded as cancelled, not as a failure. */
  cancel(id: string): boolean {
    const child = this.processes.get(id);
    const run = this.runs.get(id);
    if (!child || !run) return false;
    run.status = 'cancelled';
    child.kill();
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 3_000).unref?.();
    return true;
  }

  cancelAll(): void {
    for (const id of [...this.processes.keys()]) this.cancel(id);
  }

  private prune(): void {
    const max = this.options.maxHistory ?? 50;
    const sorted = [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt);
    for (const run of sorted.slice(max)) this.runs.delete(run.id);
  }
}

/**
 * Pull failing test names out of tool output.
 *
 * Every ecosystem prints differently and none of this is a substitute for the tool's own report,
 * so the result is best-effort context for the developer and for an AI fix suggestion.
 */
export function parseFailures(output: string, ecosystem: TestSuite['ecosystem']): TestFailure[] {
  const lines = output.split(/\r?\n/);
  const failures: TestFailure[] = [];
  const push = (name: string, index: number) => {
    if (failures.some((failure) => failure.name === name)) return;
    failures.push({
      name: name.trim().slice(0, 200),
      detail: lines
        .slice(index, index + 12)
        .join('\n')
        .slice(0, 2000),
    });
  };

  lines.forEach((line, index) => {
    if (failures.length >= 25) return;
    if (ecosystem === 'node') {
      // vitest: "FAIL  test/x.test.ts > suite > case"; jest: "● suite › case"
      const vitest = /^\s*(?:×|✕|FAIL)\s+(.+)$/.exec(line);
      if (vitest?.[1]) return push(vitest[1], index);
      const jest = /^\s*●\s+(?!Console)(.+)$/.exec(line);
      if (jest?.[1]) return push(jest[1], index);
      return;
    }
    if (ecosystem === 'python') {
      const pytest = /^(FAILED|ERROR)\s+(.+?)(?:\s+-\s+.*)?$/.exec(line);
      if (pytest?.[2]) return push(pytest[2], index);
      return;
    }
    if (ecosystem === 'rust') {
      const cargo =
        /^(?:test\s+)?(\S+)\s+\.\.\.\s+FAILED$/.exec(line) ?? /^---- (\S+) stdout ----$/.exec(line);
      if (cargo?.[1]) return push(cargo[1], index);
      return;
    }
    if (ecosystem === 'go') {
      const go = /^\s*--- FAIL:\s+(\S+)/.exec(line);
      if (go?.[1]) return push(go[1], index);
      return;
    }
    const generic = /(FAILED|FAILURE|failed|AssertionError)/.test(line) ? line : undefined;
    if (generic && line.trim().length > 8) push(generic, index);
  });

  return failures;
}

/** Quote an argument for cmd.exe when it contains spaces; suite arguments never contain quotes. */
function quoteForShell(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}
