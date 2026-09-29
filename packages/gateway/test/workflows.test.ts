import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { excludedTools, BUILTIN_ROLES } from '../src/workflows/roles.js';
import { validateGraph, WorkflowError, type Workflow } from '../src/workflows/engine.js';
import { makeRuntime, tempDir } from './helpers.js';

describe('roles', () => {
  it('never lets a workflow step write files directly', () => {
    for (const role of BUILTIN_ROLES) {
      expect(excludedTools(role)).toEqual(expect.arrayContaining(['write', 'edit']));
    }
  });

  it('maps permissions to tools', () => {
    const planner = BUILTIN_ROLES.find((r) => r.id === 'planner')!;
    const coder = BUILTIN_ROLES.find((r) => r.id === 'coder')!;
    const tester = BUILTIN_ROLES.find((r) => r.id === 'tester')!;

    expect(excludedTools(planner)).toEqual(expect.arrayContaining(['propose_change', 'exec']));
    expect(excludedTools(coder)).not.toContain('propose_change');
    expect(excludedTools(coder)).toContain('exec');
    expect(excludedTools(tester)).not.toContain('exec');
  });
});

describe('workflow validation', () => {
  const roleOf = (id: string) => BUILTIN_ROLES.find((r) => r.id === id);
  const workflow = (steps: Workflow['steps']): Workflow => ({
    id: 'w',
    name: 'W',
    description: '',
    maxParallel: 2,
    builtin: false,
    steps,
  });

  it('accepts a valid graph', () => {
    expect(() =>
      validateGraph(
        workflow([
          { id: 'a', role: 'planner', task: 't', dependsOn: [] },
          { id: 'b', role: 'coder', task: 't', dependsOn: ['a'] },
        ]),
        roleOf,
      ),
    ).not.toThrow();
  });

  it('rejects cycles, unknown roles and unknown dependencies', () => {
    expect(() =>
      validateGraph(
        workflow([
          { id: 'a', role: 'planner', task: 't', dependsOn: ['b'] },
          { id: 'b', role: 'coder', task: 't', dependsOn: ['a'] },
        ]),
        roleOf,
      ),
    ).toThrow(/cycle/);
    expect(() =>
      validateGraph(workflow([{ id: 'a', role: 'wizard', task: 't', dependsOn: [] }]), roleOf),
    ).toThrow(WorkflowError);
    expect(() =>
      validateGraph(workflow([{ id: 'a', role: 'planner', task: 't', dependsOn: ['z'] }]), roleOf),
    ).toThrow(/unknown step/);
  });
});

/** Wait until a workflow run leaves the running state. */
async function finished(rt: Awaited<ReturnType<typeof makeRuntime>>['rt'], id: string) {
  await vi.waitFor(
    () => {
      expect(rt.workflows.execution(id)?.status).not.toBe('running');
    },
    { timeout: 15_000, interval: 50 },
  );
  return rt.workflows.execution(id)!;
}

describe('running a workflow', () => {
  it('runs each role in order through real agent turns, passing outputs forward', async () => {
    const { rt, script } = await makeRuntime([
      { text: '1. Change src/auth.ts\n2. Add a test' },
      { text: 'Implemented as planned.' },
    ]);
    await rt.workflows.saveWorkflow({
      id: 'plan-and-code',
      name: 'Plan and code',
      steps: [
        { id: 'plan', role: 'planner', task: 'Plan: {{request}}' },
        { id: 'code', role: 'coder', task: 'Build: {{request}}', dependsOn: ['plan'] },
      ],
    });

    const started = await rt.workflows.start('plan-and-code', 'Improve login errors');
    const run = await finished(rt, started.id);

    expect(run.status).toBe('done');
    expect(run.steps.map((s) => [s.id, s.status])).toEqual([
      ['plan', 'done'],
      ['code', 'done'],
    ]);
    expect(run.steps[0]!.output).toContain('Change src/auth.ts');

    // The coder's prompt contained the planner's output, and each step had its own session.
    const coderPrompt = JSON.stringify(script.calls[1]);
    expect(coderPrompt).toContain('Change src/auth.ts');
    expect(coderPrompt).toContain('Your role: Coding Agent');
    expect(run.steps[0]!.sessionKey).not.toBe(run.steps[1]!.sessionKey);
  });

  it('runs independent steps side by side before the step that needs both', async () => {
    const { rt } = await makeRuntime([
      { text: 'Code findings.' },
      { text: 'Context findings.' },
      { text: 'Combined plan.' },
    ]);
    const running: string[][] = [];
    rt.workflows.on('changed', (execution) => {
      running.push(execution.steps.filter((s) => s.status === 'running').map((s) => s.id));
    });

    const started = await rt.workflows.start('research-then-plan', 'Add rate limiting');
    const run = await finished(rt, started.id);

    expect(run.status).toBe('done');
    // Both research steps were in flight at the same moment; the planner ran after them.
    expect(
      running.some((ids) => ids.includes('code-research') && ids.includes('context-research')),
    ).toBe(true);
    const plan = run.steps.find((s) => s.id === 'plan')!;
    const research = run.steps.filter((s) => s.id !== 'plan');
    expect(research.every((s) => (s.endedAt ?? 0) <= (plan.startedAt ?? 0))).toBe(true);
  });

  it('withholds write tools from every step', async () => {
    const { rt, script } = await makeRuntime([{ text: 'Plan done.' }]);
    await rt.workflows.saveWorkflow({
      id: 'one-step',
      name: 'One step',
      steps: [{ id: 'plan', role: 'planner', task: '{{request}}' }],
    });

    const started = await rt.workflows.start('one-step', 'Look around');
    await finished(rt, started.id);

    // At the provider level, tools arrive as an array of function definitions.
    const tools = ((script.calls[0] as { tools?: { name: string }[] }).tools ?? []).map(
      (t) => t.name,
    );
    expect(tools).toContain('read');
    expect(tools).not.toContain('write');
    expect(tools).not.toContain('edit');
    expect(tools).not.toContain('exec');
  });

  it('skips steps whose dependency failed', async () => {
    const { rt } = await makeRuntime([{ error: 'model unavailable' }]);
    await rt.workflows.saveWorkflow({
      id: 'fails-early',
      name: 'Fails early',
      steps: [
        { id: 'plan', role: 'planner', task: '{{request}}' },
        { id: 'code', role: 'coder', task: '{{request}}', dependsOn: ['plan'] },
      ],
    });

    const started = await rt.workflows.start('fails-early', 'Anything');
    const run = await finished(rt, started.id);

    expect(run.status).toBe('failed');
    expect(run.steps[0]!.status).toBe('failed');
    expect(run.steps[1]!.status).toBe('skipped');
  });

  it('links change sets a coding step proposed', async () => {
    const projectDir = path.join(await tempDir(), 'app');
    await fs.mkdir(path.join(projectDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectDir, 'src', 'auth.ts'), 'export const ok = true;\n');

    const { rt } = await makeRuntime([
      {
        toolCalls: [
          {
            name: 'propose_change',
            input: {
              title: 'Tighten auth',
              files: [
                { path: 'src/auth.ts', action: 'modify', content: 'export const ok = false;\n' },
              ],
            },
          },
        ],
      },
      { text: 'Proposed.' },
    ]);
    await rt.projects.add({ path: projectDir });
    await rt.refreshFsPolicy();
    await rt.workflows.saveWorkflow({
      id: 'code-only',
      name: 'Code only',
      steps: [{ id: 'code', role: 'coder', task: '{{request}}' }],
    });

    const started = await rt.workflows.start('code-only', 'Tighten auth');
    const run = await finished(rt, started.id);

    expect(run.status).toBe('done');
    expect(run.changeSetIds).toHaveLength(1);
    const change = await rt.changes.get(run.changeSetIds[0]!);
    expect(change.title).toBe('Tighten auth');
    // Proposed, not applied.
    await expect(fs.readFile(path.join(projectDir, 'src', 'auth.ts'), 'utf8')).resolves.toContain(
      'ok = true',
    );
  });

  it('persists runs and definitions across a restart', async () => {
    const { rt, stateDir } = await makeRuntime([{ text: 'done' }]);
    await rt.workflows.saveRole({
      id: 'docs-writer',
      name: 'Docs writer',
      instructions: 'Write documentation.',
      permission: 'propose',
    });
    await rt.workflows.saveWorkflow({
      id: 'docs',
      name: 'Docs',
      steps: [{ id: 'write', role: 'docs-writer', task: '{{request}}' }],
    });
    const started = await rt.workflows.start('docs', 'Document the API');
    await finished(rt, started.id);

    const again = await makeRuntime([], { runtime: { stateDir } as never });
    void again;
    const { WorkflowEngine } = await import('../src/workflows/engine.js');
    const engine = new WorkflowEngine({
      dir: path.join(stateDir, 'workflows'),
      agentId: 'main',
      runAndWait: () => Promise.reject(new Error('unused')),
      abort: () => false,
      changesProposedBy: () => Promise.resolve([]),
      projectContext: () => Promise.resolve(undefined),
    });
    await engine.load();
    expect(engine.listRoles().map((r) => r.id)).toContain('docs-writer');
    expect(engine.listWorkflows().map((w) => w.id)).toContain('docs');
    expect(engine.execution(started.id)?.status).toBe('done');
  });

  it('refuses to shadow a built-in role or workflow', async () => {
    const { rt } = await makeRuntime([]);
    await expect(
      rt.workflows.saveRole({ id: 'planner', name: 'Mine', instructions: 'x', permission: 'read' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      rt.workflows.saveWorkflow({
        id: 'plan-code-test-review',
        name: 'Mine',
        steps: [{ id: 'a', role: 'planner', task: 'x' }],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
