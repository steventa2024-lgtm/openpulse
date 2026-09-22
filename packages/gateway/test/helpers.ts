import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import { Runtime, type RuntimeOptions } from '../src/runtime.js';
import { scriptedModel, type ScriptedStep } from './llm-helpers.js';

const dirs: string[] = [];
const runtimes: Runtime[] = [];

export async function tempDir(prefix = 'openpulse-test-'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.stop().catch(() => undefined)));
  await Promise.all(
    dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true, maxRetries: 5 })),
  );
});

export interface TestRuntime {
  rt: Runtime;
  script: ReturnType<typeof scriptedModel>;
  stateDir: string;
}

/** A runtime on a throwaway state dir with a scripted model and no channels/cron/heartbeat. */
export async function makeRuntime(
  steps: ScriptedStep[] = [],
  options: {
    config?: Record<string, unknown>;
    start?: boolean;
    runtime?: Partial<RuntimeOptions>;
  } = {},
): Promise<TestRuntime> {
  const stateDir = path.join(await tempDir(), '.openpulse');
  await fs.mkdir(stateDir, { recursive: true });
  const config = {
    gateway: { auth: { mode: 'token', token: 'test-token' } },
    agents: { defaults: { heartbeat: { every: '0m' } } },
    ...(options.config ?? {}),
  };
  await fs.writeFile(path.join(stateDir, 'openpulse.json'), JSON.stringify(config, null, 2));

  const script = scriptedModel(steps);
  const rt = await Runtime.create({
    stateDir,
    env: {},
    modelFactory: script.factory,
    ...options.runtime,
  });
  runtimes.push(rt);
  if (options.start) await rt.start({ channels: false, cron: false, heartbeat: false });
  return { rt, script, stateDir };
}

export function registerRuntime(rt: Runtime): void {
  runtimes.push(rt);
}
