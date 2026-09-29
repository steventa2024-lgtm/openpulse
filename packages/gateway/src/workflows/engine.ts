import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { DispatchParams } from '../agent/agent-service.js';
import type { RunResult } from '../agent/runner.js';
import { readTextOr, writeFileAtomic } from '../util/fs.js';
import { BUILTIN_ROLES, excludedTools, RoleSchema, type Role } from './roles.js';

export const StepSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/),
  role: z.string(),
  /** What this step should do. `{{request}}` is the user's request. */
  task: z.string().min(1).max(4000),
  /** Steps whose output this one needs. Steps with no dependencies may run in parallel. */
  dependsOn: z.array(z.string()).default([]),
});

export const WorkflowSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,60}$/),
  name: z.string().min(1).max(120),
  description: z.string().max(400).default(''),
  steps: z.array(StepSchema).min(1).max(20),
  /** How many independent steps may run at once. */
  maxParallel: z.number().int().min(1).max(4).default(2),
  builtin: z.boolean().default(false),
});

export type WorkflowStep = z.output<typeof StepSchema>;
export type Workflow = z.output<typeof WorkflowSchema>;

export interface StepExecution {
  id: string;
  role: string;
  roleName: string;
  task: string;
  dependsOn: string[];
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'cancelled';
  sessionKey: string;
  runId?: string;
  model?: string;
  output?: string;
  error?: string;
  toolCalls?: number;
  startedAt?: number;
  endedAt?: number;
}

export interface WorkflowExecution {
  id: string;
  workflowId: string;
  workflowName: string;
  projectId?: string;
  request: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  createdAt: number;
  endedAt?: number;
  steps: StepExecution[];
  /** Change sets the coding steps proposed, ready for review. */
  changeSetIds: string[];
  error?: string;
}

export interface WorkflowEngineDeps {
  dir: string;
  agentId: string;
  /** Runs one agent turn and resolves when it finishes. */
  runAndWait: (params: DispatchParams) => Promise<RunResult>;
  abort: (sessionKey: string) => boolean;
  /** Change sets created since a given moment in a given session, to link them to the step. */
  changesProposedBy: (sessionKey: string, since: number) => Promise<string[]>;
  /** Context about the active project, injected into every step. */
  projectContext: () => Promise<{ id: string; name: string; path: string } | undefined>;
}

export class WorkflowError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'INVALID' | 'CONFLICT',
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowError';
  }
}

export const BUILTIN_WORKFLOWS: Workflow[] = [
  {
    id: 'plan-code-test-review',
    name: 'Plan, code, test, review',
    description:
      'A planner scopes the work, a coder proposes the change, a tester runs the tests and a reviewer checks it all.',
    maxParallel: 2,
    builtin: true,
    steps: [
      {
        id: 'plan',
        role: 'planner',
        task: 'Make a plan for this request:\n\n{{request}}',
        dependsOn: [],
      },
      {
        id: 'code',
        role: 'coder',
        task: 'Implement the plan for this request as a proposed change:\n\n{{request}}',
        dependsOn: ['plan'],
      },
      {
        id: 'test',
        role: 'tester',
        task: 'Run the project tests and report the result. The request was:\n\n{{request}}',
        dependsOn: ['code'],
      },
      {
        id: 'review',
        role: 'reviewer',
        task: 'Review the plan, the proposed change and the test result for this request:\n\n{{request}}',
        dependsOn: ['code', 'test'],
      },
    ],
  },
  {
    id: 'research-then-plan',
    name: 'Research, then plan',
    description:
      'Two researchers look into the code and the wider context in parallel, then a planner combines their findings.',
    maxParallel: 2,
    builtin: true,
    steps: [
      {
        id: 'code-research',
        role: 'researcher',
        task: 'Investigate how the existing code relates to this request:\n\n{{request}}',
        dependsOn: [],
      },
      {
        id: 'context-research',
        role: 'researcher',
        task: 'Research libraries, documentation or approaches relevant to this request:\n\n{{request}}',
        dependsOn: [],
      },
      {
        id: 'plan',
        role: 'planner',
        task: 'Using the research, make a plan for:\n\n{{request}}',
        dependsOn: ['code-research', 'context-research'],
      },
    ],
  },
];

const MAX_CONTEXT_PER_STEP = 12_000;

/**
 * Coordinates several agents on one request.
 *
 * Each step runs as an ordinary agent turn in its own session, with a role that sets its
 * instructions, model and tools. Steps run in dependency order; independent steps run side by side
 * up to a limit. Outputs flow forward as context. No step writes files: coding roles propose
 * changes, so parallel agents cannot overwrite each other and a human reviews everything before it
 * lands.
 */
export class WorkflowEngine extends EventEmitter<{ changed: [WorkflowExecution] }> {
  private roles: Role[] = [];
  private workflows: Workflow[] = [];
  private readonly executions = new Map<string, WorkflowExecution>();
  private readonly cancelled = new Set<string>();

  constructor(private readonly deps: WorkflowEngineDeps) {
    super();
    this.setMaxListeners(50);
  }

  async load(): Promise<void> {
    const raw = await readTextOr(path.join(this.deps.dir, 'definitions.json'), '');
    const parsed = raw
      ? z
          .object({
            roles: z.array(RoleSchema).default([]),
            workflows: z.array(WorkflowSchema).default([]),
          })
          .safeParse(JSON.parse(raw))
      : undefined;
    this.roles = parsed?.success ? parsed.data.roles.filter((r) => !r.builtin) : [];
    this.workflows = parsed?.success ? parsed.data.workflows.filter((w) => !w.builtin) : [];

    const executionsDir = path.join(this.deps.dir, 'executions');
    const names = await fsp.readdir(executionsDir).catch(() => [] as string[]);
    for (const name of names.filter((n) => n.endsWith('.json')).slice(-100)) {
      const text = await readTextOr(path.join(executionsDir, name), '');
      if (!text) continue;
      try {
        const execution = JSON.parse(text) as WorkflowExecution;
        // A run the gateway was restarted in the middle of did not finish.
        if (execution.status === 'running') {
          execution.status = 'failed';
          execution.error = 'The gateway restarted while this workflow was running.';
          for (const step of execution.steps)
            if (step.status === 'running' || step.status === 'pending') step.status = 'cancelled';
        }
        this.executions.set(execution.id, execution);
      } catch {
        // skip unreadable records
      }
    }
  }

  listRoles(): Role[] {
    return [...BUILTIN_ROLES, ...this.roles];
  }

  listWorkflows(): Workflow[] {
    return [...BUILTIN_WORKFLOWS, ...this.workflows];
  }

  role(id: string): Role | undefined {
    return this.listRoles().find((role) => role.id === id);
  }

  async saveRole(input: unknown): Promise<Role> {
    const role = RoleSchema.parse({ ...(input as object), builtin: false });
    if (BUILTIN_ROLES.some((r) => r.id === role.id)) {
      throw new WorkflowError('CONFLICT', `"${role.id}" is a built-in role; choose another id.`);
    }
    this.roles = [...this.roles.filter((r) => r.id !== role.id), role];
    await this.saveDefinitions();
    return role;
  }

  async removeRole(id: string): Promise<boolean> {
    const usedBy = this.workflows.filter((w) => w.steps.some((s) => s.role === id));
    if (usedBy.length > 0) {
      throw new WorkflowError(
        'CONFLICT',
        `The role is used by: ${usedBy.map((w) => w.name).join(', ')}.`,
      );
    }
    const before = this.roles.length;
    this.roles = this.roles.filter((r) => r.id !== id);
    await this.saveDefinitions();
    return this.roles.length < before;
  }

  async saveWorkflow(input: unknown): Promise<Workflow> {
    const workflow = WorkflowSchema.parse({ ...(input as object), builtin: false });
    if (BUILTIN_WORKFLOWS.some((w) => w.id === workflow.id)) {
      throw new WorkflowError(
        'CONFLICT',
        `"${workflow.id}" is a built-in workflow; choose another id.`,
      );
    }
    validateGraph(workflow, (id) => this.role(id));
    this.workflows = [...this.workflows.filter((w) => w.id !== workflow.id), workflow];
    await this.saveDefinitions();
    return workflow;
  }

  async removeWorkflow(id: string): Promise<boolean> {
    const before = this.workflows.length;
    this.workflows = this.workflows.filter((w) => w.id !== id);
    await this.saveDefinitions();
    return this.workflows.length < before;
  }

  executionsList(limit = 30): WorkflowExecution[] {
    return [...this.executions.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  execution(id: string): WorkflowExecution | undefined {
    return this.executions.get(id);
  }

  /** Start a workflow. Resolves immediately; progress arrives through "changed" events. */
  async start(workflowId: string, request: string): Promise<WorkflowExecution> {
    const workflow = this.listWorkflows().find((w) => w.id === workflowId);
    if (!workflow) throw new WorkflowError('NOT_FOUND', `No workflow called "${workflowId}".`);
    validateGraph(workflow, (id) => this.role(id));
    const project = await this.deps.projectContext();

    const id = randomUUID();
    const execution: WorkflowExecution = {
      id,
      workflowId: workflow.id,
      workflowName: workflow.name,
      ...(project && { projectId: project.id }),
      request,
      status: 'running',
      createdAt: Date.now(),
      changeSetIds: [],
      steps: workflow.steps.map((step) => {
        const role = this.role(step.role)!;
        return {
          id: step.id,
          role: role.id,
          roleName: role.name,
          task: step.task.replaceAll('{{request}}', request),
          dependsOn: step.dependsOn,
          status: 'pending' as const,
          sessionKey: `agent:${this.deps.agentId}:wf:${id.slice(0, 8)}:${step.id}`,
          ...(role.model && { model: role.model }),
        };
      }),
    };
    this.executions.set(id, execution);
    await this.persist(execution);
    this.emit('changed', execution);

    void this.drive(execution, workflow.maxParallel, project).catch(async (error: unknown) => {
      execution.status = 'failed';
      execution.error = (error as Error).message;
      execution.endedAt = Date.now();
      await this.persist(execution);
      this.emit('changed', execution);
    });
    return execution;
  }

  /** Stop a running workflow: running steps are aborted, pending ones never start. */
  async cancel(id: string): Promise<WorkflowExecution> {
    const execution = this.executions.get(id);
    if (!execution) throw new WorkflowError('NOT_FOUND', `No workflow run ${id}.`);
    if (execution.status !== 'running') return execution;
    this.cancelled.add(id);
    for (const step of execution.steps) {
      if (step.status === 'running') this.deps.abort(step.sessionKey);
      if (step.status === 'pending') step.status = 'cancelled';
    }
    execution.status = 'cancelled';
    execution.endedAt = Date.now();
    await this.persist(execution);
    this.emit('changed', execution);
    return execution;
  }

  // -----------------------------------------------------------------------------------------------

  private async drive(
    execution: WorkflowExecution,
    maxParallel: number,
    project: { id: string; name: string; path: string } | undefined,
  ): Promise<void> {
    const running = new Map<string, Promise<void>>();

    const ready = () =>
      execution.steps.filter(
        (step) =>
          step.status === 'pending' &&
          step.dependsOn.every(
            (dep) => execution.steps.find((s) => s.id === dep)?.status === 'done',
          ),
      );

    while (!this.cancelled.has(execution.id)) {
      // A failed dependency means dependants can never run.
      for (const step of execution.steps) {
        if (step.status !== 'pending') continue;
        const blocked = step.dependsOn.some((dep) => {
          const status = execution.steps.find((s) => s.id === dep)?.status;
          return status === 'failed' || status === 'skipped' || status === 'cancelled';
        });
        if (blocked) {
          step.status = 'skipped';
          step.error = 'A step it depends on did not finish.';
        }
      }

      for (const step of ready()) {
        if (running.size >= maxParallel) break;
        const task = this.runStep(execution, step, project).finally(() => running.delete(step.id));
        running.set(step.id, task);
      }

      if (running.size === 0) break;
      await Promise.race(running.values());
    }
    await Promise.all(running.values());

    if (execution.status === 'running') {
      const failed = execution.steps.some((s) => s.status === 'failed');
      execution.status = failed ? 'failed' : 'done';
      execution.endedAt = Date.now();
      if (failed) execution.error = 'One or more steps failed.';
    }
    this.cancelled.delete(execution.id);
    await this.persist(execution);
    this.emit('changed', execution);
  }

  private async runStep(
    execution: WorkflowExecution,
    step: StepExecution,
    project: { id: string; name: string; path: string } | undefined,
  ): Promise<void> {
    const role = this.role(step.role)!;
    step.status = 'running';
    step.startedAt = Date.now();
    this.emit('changed', execution);

    const upstream = step.dependsOn
      .map((dep) => execution.steps.find((s) => s.id === dep))
      .filter((s): s is StepExecution => Boolean(s?.output))
      .map(
        (s) => `### ${s.roleName} (${s.id})\n${(s.output ?? '').slice(0, MAX_CONTEXT_PER_STEP)}`,
      );

    const proposed = execution.changeSetIds.length
      ? `\n\nChange sets proposed so far (pending review, not applied): ${execution.changeSetIds.join(', ')}`
      : '';

    const message = [
      step.task,
      upstream.length ? `\n\n## Work from earlier steps\n\n${upstream.join('\n\n')}` : '',
      proposed,
    ].join('');

    const extraSystemPrompt = [
      `## Your role: ${role.name}`,
      role.instructions,
      '',
      `You are step "${step.id}" of the workflow "${execution.workflowName}".`,
      project
        ? `The project is "${project.name}" at ${project.path}. Work inside it.`
        : 'No project is selected.',
    ].join('\n');

    let finalStatus: StepExecution['status'];
    try {
      const result = await this.deps.runAndWait({
        sessionKey: step.sessionKey,
        message,
        source: {
          kind: 'user',
          channel: 'workflow',
          senderName: `workflow:${execution.workflowName}`,
        },
        extraSystemPrompt,
        excludeTools: excludedTools(role),
        ...(role.model && { model: role.model }),
      });
      step.runId = result.runId;
      step.toolCalls = result.toolCalls;
      step.model = result.model;
      step.output = result.text;

      // Link the change sets before the step counts as finished: a dependent step (the reviewer,
      // say) must see them in its context, and it starts as soon as this step is "done".
      const changeSets = await this.deps
        .changesProposedBy(step.sessionKey, step.startedAt)
        .catch(() => []);
      for (const changeId of changeSets) {
        if (!execution.changeSetIds.includes(changeId)) execution.changeSetIds.push(changeId);
      }

      if (result.error) step.error = result.error;
      finalStatus = result.aborted ? 'cancelled' : result.error ? 'failed' : 'done';
    } catch (error) {
      step.error = (error as Error).message;
      finalStatus = 'failed';
    }
    step.endedAt = Date.now();
    step.status = finalStatus;
    await this.persist(execution);
    this.emit('changed', execution);
  }

  private async persist(execution: WorkflowExecution): Promise<void> {
    const dir = path.join(this.deps.dir, 'executions');
    await fsp.mkdir(dir, { recursive: true });
    await writeFileAtomic(
      path.join(dir, `${execution.id}.json`),
      `${JSON.stringify(execution, null, 2)}\n`,
    );
  }

  private async saveDefinitions(): Promise<void> {
    await fsp.mkdir(this.deps.dir, { recursive: true });
    await writeFileAtomic(
      path.join(this.deps.dir, 'definitions.json'),
      `${JSON.stringify({ roles: this.roles, workflows: this.workflows }, null, 2)}\n`,
    );
  }
}

/** Every step names a real role and real dependencies, and there are no cycles. */
export function validateGraph(workflow: Workflow, roleOf: (id: string) => Role | undefined): void {
  const ids = new Set(workflow.steps.map((s) => s.id));
  if (ids.size !== workflow.steps.length)
    throw new WorkflowError('INVALID', 'Step ids must be unique.');
  for (const step of workflow.steps) {
    if (!roleOf(step.role))
      throw new WorkflowError('INVALID', `Step "${step.id}" uses an unknown role "${step.role}".`);
    for (const dep of step.dependsOn) {
      if (!ids.has(dep))
        throw new WorkflowError(
          'INVALID',
          `Step "${step.id}" depends on an unknown step "${dep}".`,
        );
      if (dep === step.id)
        throw new WorkflowError('INVALID', `Step "${step.id}" cannot depend on itself.`);
    }
  }
  // Kahn's algorithm: if we cannot order every step, there is a cycle.
  const indegree = new Map(workflow.steps.map((s) => [s.id, s.dependsOn.length]));
  const queue = workflow.steps.filter((s) => s.dependsOn.length === 0).map((s) => s.id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift()!;
    visited += 1;
    for (const step of workflow.steps) {
      if (!step.dependsOn.includes(id)) continue;
      const remaining = (indegree.get(step.id) ?? 0) - 1;
      indegree.set(step.id, remaining);
      if (remaining === 0) queue.push(step.id);
    }
  }
  if (visited !== workflow.steps.length)
    throw new WorkflowError('INVALID', 'The workflow has a dependency cycle.');
}
